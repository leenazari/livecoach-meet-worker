// LiveCoach Meet worker
// -----------------------------------------------------------------------------
// Recall webhook -> verified account scope -> private websocket room + Supabase
//
// The service role key never reaches a browser. Browsers receive a short-lived
// opaque token from LiveCoach and send it as a websocket subprotocol. Recall
// receives a different per-bot webhook token. Both are stored only as SHA-256
// hashes and bind one user to one call session.

import http from "http";
import { parse } from "url";
import express from "express";
import { WebSocketServer } from "ws";
import { Webhook } from "svix";
import {
  extractStreamToken,
  extractUtterance,
  hashStreamToken,
  roomKey,
  subscriberRoomKeys,
  utteranceMatchesScope,
  validSessionId,
  validWebhookToken,
  validUuid,
} from "./security.js";

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET =
  process.env.RECALL_WORKSPACE_VERIFICATION_SECRET ||
  process.env.RECALL_WEBHOOK_SECRET ||
  "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const canPersist = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const ready = canPersist;
if (!canPersist) {
  console.error(
    "[config] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"
  );
}
if (!WEBHOOK_SECRET) {
  console.warn(
    "[config] Recall workspace signature verification is not configured; short-lived per-bot tokens remain mandatory"
  );
}

function restUrl(table, params = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function supabaseFetch(table, params, init = {}) {
  if (!canPersist) throw new Error("Supabase persistence is not configured");
  return fetch(restUrl(table, params), {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
}

async function selectRows(table, params) {
  const response = await supabaseFetch(table, params);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Supabase ${table} lookup failed ${response.status} ${detail.slice(0, 180)}`
    );
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

async function persistUtterance(row) {
  const deduplicated = !!row.provider_event_id;
  const response = await supabaseFetch(
    "meet_utterances",
    deduplicated ? { on_conflict: "provider_event_id" } : {},
    {
      method: "POST",
      headers: {
        Prefer: deduplicated
          ? "resolution=ignore-duplicates,return=minimal"
          : "return=minimal",
      },
      body: JSON.stringify(row),
    }
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Supabase utterance insert failed ${response.status} ${detail.slice(0, 180)}`
    );
  }
}

async function validateWebhookToken(rawToken) {
  if (!validWebhookToken(rawToken)) return null;
  const tokenHash = hashStreamToken(rawToken);
  const rows = await selectRows("meet_bots", {
    select:
      "id,bot_id,session_id,owner_id,workspace_id,webhook_token_expires_at,status",
    webhook_token_hash: `eq.${tokenHash}`,
    webhook_token_expires_at: `gt.${new Date().toISOString()}`,
    status: "eq.active",
    limit: "2",
  });
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (
    !validUuid(row.id) ||
    !row.bot_id ||
    !validSessionId(row.session_id) ||
    !validUuid(row.owner_id) ||
    !validUuid(row.workspace_id)
  ) {
    return null;
  }
  return {
    captureId: row.id,
    botId: row.bot_id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
  };
}

const subscriberCache = new Map();
async function activeSubscriberKeys(scope) {
  const cached = subscriberCache.get(scope.captureId);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const subscribers = await selectRows("meet_capture_subscribers", {
    select: "owner_id,workspace_id,session_id,status",
    capture_id: `eq.${scope.captureId}`,
    workspace_id: `eq.${scope.workspaceId}`,
    status: "eq.active",
    limit: "20",
  });
  const keys = subscriberRoomKeys(subscribers, scope);
  subscriberCache.set(scope.captureId, {
    keys,
    expiresAt: Date.now() + 1500,
  });
  return keys;
}

async function validateStreamToken(sessionId, rawToken) {
  if (!validSessionId(sessionId) || !rawToken) return null;
  const tokenHash = hashStreamToken(rawToken);
  const now = new Date().toISOString();
  const rows = await selectRows("meet_stream_tokens", {
    select: "owner_id,workspace_id,session_id,expires_at",
    token_hash: `eq.${tokenHash}`,
    session_id: `eq.${sessionId}`,
    revoked_at: "is.null",
    expires_at: `gt.${now}`,
    limit: "2",
  });
  if (rows.length !== 1) return null;
  const row = rows[0];
  const key = roomKey(row.owner_id, row.session_id);
  if (!key || !validUuid(row.workspace_id)) return null;

  supabaseFetch(
    "meet_stream_tokens",
    { token_hash: `eq.${tokenHash}`, session_id: `eq.${sessionId}` },
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        last_used_at: now,
        updated_at: now,
      }),
    }
  ).catch((error) =>
    console.error("[supabase] token usage stamp failed", error.message)
  );

  return { key, ownerId: row.owner_id, workspaceId: row.workspace_id };
}

// Browser rooms are keyed by verified owner and call session. The same random
// session id in two accounts can never share a transcript channel.
const rooms = new Map();
function addClient(key, ws) {
  if (!rooms.has(key)) rooms.set(key, new Set());
  rooms.get(key).add(ws);
}
function removeClient(key, ws) {
  const clients = rooms.get(key);
  if (!clients) return;
  clients.delete(ws);
  if (clients.size === 0) rooms.delete(key);
}
function broadcast(key, message) {
  const clients = rooms.get(key);
  if (!clients) return;
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

const app = express();
app.get("/", (_req, res) => res.send("LiveCoach Meet worker is up"));
app.get("/healthz", (_req, res) =>
  res.status(ready ? 200 : 503).json({
    ok: ready,
    rooms: rooms.size,
    perBotTokenVerification: true,
    workspaceSignatureVerification: !!WEBHOOK_SECRET,
    persistence: canPersist,
  })
);

app.post("/webhook/recall", express.raw({ type: "*/*" }), async (req, res) => {
  if (!ready) return res.status(503).send("worker is not securely configured");
  const payload = req.body?.toString("utf8") || "";
  const eventId =
    req.header("webhook-id") || req.header("svix-id") || null;
  const webhookScope = await validateWebhookToken(String(req.query.token || "")).catch(
    (error) => {
      console.error("[webhook] private token lookup failed", error.message);
      return null;
    }
  );
  if (!webhookScope) {
    return res.status(401).send("private bot webhook access denied");
  }

  if (WEBHOOK_SECRET) {
    try {
      new Webhook(WEBHOOK_SECRET).verify(payload, {
        "svix-id": eventId || "",
        "svix-timestamp":
          req.header("webhook-timestamp") ||
          req.header("svix-timestamp") ||
          "",
        "svix-signature":
          req.header("webhook-signature") ||
          req.header("svix-signature") ||
          "",
      });
    } catch (error) {
      console.error("[webhook] signature verification failed", error.message);
      return res.status(400).send("invalid signature");
    }
  }

  // Recall requires a fast acknowledgement. Scope resolution, persistence and
  // relay happen after the verified payload has been accepted.
  res.status(200).send("ok");

  try {
    const event = JSON.parse(payload);
    if (event.event !== "transcript.data") return;
    const utterance = extractUtterance(event);
    if (!utterance.text || !utteranceMatchesScope(utterance, webhookScope)) {
      console.error(
        "[scope] transcript dropped because bot, account or call metadata did not match"
      );
      return;
    }
    const timestamp = new Date().toISOString();
    const message = {
      type: "utterance",
      speaker: utterance.speaker,
      role: utterance.role,
      text: utterance.text,
      isFinal: true,
      ts: timestamp,
    };
    const subscriberKeys = await activeSubscriberKeys(webhookScope);
    for (const key of subscriberKeys) broadcast(key, message);

    // Persist the provider utterance once under the capture owner. Subscriber
    // sessions read this source on demand and keep only their private coaching
    // state and summary, so a two-person team call never doubles raw storage.
    await persistUtterance({
      session_id: webhookScope.sessionId,
      bot_id: webhookScope.botId,
      provider_event_id: eventId,
      speaker: utterance.speaker,
      role: utterance.role,
      text: utterance.text,
      is_final: true,
      ts: timestamp,
      owner_id: webhookScope.ownerId,
      workspace_id: webhookScope.workspaceId,
      visibility: "private",
    });
  } catch (error) {
    console.error("[webhook] processing error", error.message);
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  handleProtocols(protocols) {
    return protocols.has("livecoach-v1") ? "livecoach-v1" : false;
  },
});

wss.on("connection", async (ws, req) => {
  const { query } = parse(req.url, true);
  const sessionId = String(query.session || "");
  const token = extractStreamToken(req.headers["sec-websocket-protocol"]);
  try {
    const scope = await validateStreamToken(sessionId, token);
    if (!scope) {
      ws.close(4401, "private stream access denied");
      return;
    }
    addClient(scope.key, ws);
    ws.send(JSON.stringify({ type: "connected", session: sessionId }));
    ws.on("close", () => removeClient(scope.key, ws));
    ws.on("error", () => removeClient(scope.key, ws));
  } catch (error) {
    console.error("[websocket] access lookup failed", error.message);
    ws.close(4403, "private stream unavailable");
  }
});

server.listen(PORT, () => {
  console.log(`[worker] listening on ${PORT}`);
  console.log(`[worker] secure configuration ${ready ? "ready" : "incomplete"}`);
});
