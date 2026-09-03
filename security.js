import { createHash } from "crypto";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION = /^lc-[a-z0-9-]{6,80}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validSessionId(value) {
  return typeof value === "string" && SESSION.test(value);
}

export function validWebhookToken(value) {
  return typeof value === "string" && TOKEN.test(value);
}

export function validUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

export function extractStreamToken(protocolHeader) {
  const protocols = String(protocolHeader || "")
    .split(",")
    .map((value) => value.trim());
  const wrapped = protocols.find((value) => value.startsWith("livecoach-token."));
  if (!wrapped) return null;
  const token = wrapped.slice("livecoach-token.".length);
  return TOKEN.test(token) ? token : null;
}

export function hashStreamToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function roomKey(ownerId, sessionId) {
  if (!validUuid(ownerId) || !validSessionId(sessionId)) return null;
  return `${ownerId}:${sessionId}`;
}

export function subscriberRoomKeys(rows, captureScope) {
  if (!Array.isArray(rows) || !validUuid(captureScope?.workspaceId)) return [];
  const keys = new Set();
  for (const row of rows) {
    if (
      row?.status !== "active" ||
      row?.workspace_id !== captureScope.workspaceId
    ) {
      continue;
    }
    const key = roomKey(row?.owner_id, row?.session_id);
    if (key) keys.add(key);
  }
  return Array.from(keys);
}

export function utteranceMatchesScope(utterance, scope) {
  return !!(
    utterance &&
    scope &&
    utterance.botId &&
    utterance.botId === scope.botId &&
    utterance.sessionId === scope.sessionId &&
    utterance.metadataOwnerId === scope.ownerId &&
    utterance.metadataWorkspaceId === scope.workspaceId
  );
}

export function extractUtterance(event) {
  const payload = event?.data || {};
  const bot =
    payload?.bot || payload?.data?.bot || payload?.transcript?.bot || {};
  const metadata =
    bot?.metadata || payload?.metadata || payload?.data?.metadata || {};
  const transcript = payload?.data || payload?.transcript || payload;
  const text =
    (Array.isArray(transcript?.words)
      ? transcript.words.map((word) => word?.text || "").join(" ")
      : transcript?.text || "") || "";
  const participant = transcript?.participant || payload?.participant || {};
  return {
    botId: String(bot?.id || payload?.bot_id || ""),
    sessionId: String(metadata?.session_id || ""),
    metadataOwnerId: String(metadata?.owner_id || ""),
    metadataWorkspaceId: String(metadata?.workspace_id || ""),
    speaker: String(participant?.name || ""),
    role: participant?.is_host ? "host" : "guest",
    text: String(text).trim(),
  };
}
