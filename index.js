// LiveCoach Meet worker
// -----------------------------------------------------------------------------
// One small always-on service that bridges Recall.ai -> the LiveCoach call page.
//
//   Recall (webhook)  -->  THIS WORKER  -->  call page (websocket)
//                                       \->  Supabase (persistence / refresh recovery)
//
// Recall delivers each finalised utterance to POST /webhook/recall. We verify
// the signature, ACK immediately, then relay the utterance to any browser
// connected on /ws?session=<room> AND insert it into meet_utterances.
//
// Env vars (set these in Railway -> Variables):
//   PORT                        - provided by Railway automatically
//   RECALL_WEBHOOK_SECRET       - workspace verification secret from Recall
//   SUPABASE_URL                - your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (server-only, never browser)
//
// The Recall API KEY is NOT needed here - the worker only receives & relays.
// The bot is dispatched from the Vercel app (Stage C), which carries the key.
// -----------------------------------------------------------------------------

import http from "http";
import { parse } from "url";
import express from "express";
import { WebSocketServer } from "ws";
import { Webhook } from "svix";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.RECALL_WEBHOOK_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

if (!supabase) {
  console.warn(
    "[warn] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set - utterances will relay but NOT persist."
  );
}
if (!WEBHOOK_SECRET) {
  console.warn(
    "[warn] RECALL_WEBHOOK_SECRET not set - webhook signature verification is DISABLED. Set it before real use."
  );
}

// --- browser websocket rooms: session_id -> Set<ws> --------------------------
const rooms = new Map();
function addClient(session, ws) {
  if (!rooms.has(session)) rooms.set(session, new Set());
  rooms.get(session).add(ws);
}
function removeClient(session, ws) {
  const set = rooms.get(session);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) rooms.delete(session);
}
function broadcast(session, obj) {
  const set = rooms.get(session);
  if (!set) return;
  const data = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// --- defensively pull the bits we need out of a transcript.data event --------
function extractUtterance(evt) {
  const d = evt.data || {};
  // metadata carrying our room id (set when the bot is created in Stage C)
  const sessionId =
    d?.bot?.metadata?.session_id ||
    d?.metadata?.session_id ||
    d?.data?.bot?.metadata?.session_id ||
    "";
  // transcript payload can be nested a couple of ways across versions
  const t = d.data || d.transcript || d;
  const text =
    (Array.isArray(t?.words)
      ? t.words.map((w) => w.text).join(" ")
      : t?.text || "") || "";
  const participant = t?.participant || d?.participant || {};
  const speaker = participant?.name || "";
  const isHost = !!participant?.is_host;
  return {
    sessionId,
    speaker,
    role: isHost ? "host" : "guest",
    text: text.trim(),
  };
}

const app = express();
app.get("/", (_req, res) => res.send("LiveCoach Meet worker: up"));
app.get("/healthz", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// Recall webhook. RAW body required for signature verification.
let loggedFirst = false;
app.post(
  "/webhook/recall",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    const payload = req.body?.toString("utf8") || "";

    if (WEBHOOK_SECRET) {
      try {
        new Webhook(WEBHOOK_SECRET).verify(payload, {
          "svix-id": req.header("svix-id") || "",
          "svix-timestamp": req.header("svix-timestamp") || "",
          "svix-signature": req.header("svix-signature") || "",
        });
      } catch (e) {
        console.error("[webhook] signature verification failed:", e.message);
        return res.status(400).send("invalid signature");
      }
    }

    // ACK immediately - Recall requires a fast 2xx; do work afterwards.
    res.status(200).send("ok");

    try {
      const evt = JSON.parse(payload);

      // One-time dump of the first event so we can confirm the exact shape.
      if (!loggedFirst) {
        loggedFirst = true;
        console.log("[webhook] first event sample:", payload.slice(0, 1200));
      }

      if (evt.event !== "transcript.data") return;

      const u = extractUtterance(evt);
      if (!u.sessionId || !u.text) return;

      const ts = new Date().toISOString();
      broadcast(u.sessionId, {
        type: "utterance",
        speaker: u.speaker,
        role: u.role,
        text: u.text,
        isFinal: true,
        ts,
      });

      if (supabase) {
        const { error } = await supabase.from("meet_utterances").insert({
          session_id: u.sessionId,
          speaker: u.speaker,
          role: u.role,
          text: u.text,
          is_final: true,
          ts,
        });
        if (error) console.error("[supabase] insert error:", error.message);
      }
    } catch (e) {
      console.error("[webhook] processing error:", e.message);
    }
  }
);

const server = http.createServer(app);

// Browser websocket: the call page connects to wss://<worker>/ws?session=<room>
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  const { query } = parse(req.url, true);
  const session = (query.session || "").toString();
  if (!session) {
    ws.close(1008, "missing session");
    return;
  }
  addClient(session, ws);
  ws.send(JSON.stringify({ type: "connected", session }));
  ws.on("close", () => removeClient(session, ws));
  ws.on("error", () => removeClient(session, ws));
});

server.listen(PORT, () => {
  console.log(`[worker] listening on :${PORT}`);
  console.log(`[worker] webhook:   POST /webhook/recall`);
  console.log(`[worker] browser:   WS   /ws?session=<room>`);
});
