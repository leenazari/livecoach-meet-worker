import assert from "node:assert/strict";
import test from "node:test";
import {
  extractStreamToken,
  extractUtterance,
  hashStreamToken,
  roomKey,
  subscriberRoomKeys,
  utteranceMatchesScope,
  validSessionId,
  validWebhookToken,
} from "./security.js";

const token = "a".repeat(43);

test("stream tokens are read only from the private websocket protocol", () => {
  assert.equal(
    extractStreamToken(`livecoach-v1, livecoach-token.${token}`),
    token
  );
  assert.equal(extractStreamToken("livecoach-v1"), null);
  assert.equal(extractStreamToken("livecoach-token.short"), null);
});

test("rooms are namespaced by the verified account", () => {
  const userA = "11111111-1111-4111-8111-111111111111";
  const userB = "22222222-2222-4222-8222-222222222222";
  assert.notEqual(roomKey(userA, "lc-same-room"), roomKey(userB, "lc-same-room"));
  assert.equal(roomKey(userA, "not-a-livecoach-room"), null);
});

test("one capture fans out only to active subscribers in its workspace", () => {
  const workspaceId = "33333333-3333-4333-8333-333333333333";
  const userA = "11111111-1111-4111-8111-111111111111";
  const userB = "22222222-2222-4222-8222-222222222222";
  const outsider = "44444444-4444-4444-8444-444444444444";
  const keys = subscriberRoomKeys(
    [
      {
        owner_id: userA,
        workspace_id: workspaceId,
        session_id: "lc-lee-call",
        status: "active",
      },
      {
        owner_id: userB,
        workspace_id: workspaceId,
        session_id: "lc-kamm-call",
        status: "active",
      },
      {
        owner_id: outsider,
        workspace_id: "55555555-5555-4555-8555-555555555555",
        session_id: "lc-private-call",
        status: "active",
      },
      {
        owner_id: userA,
        workspace_id: workspaceId,
        session_id: "lc-old-call",
        status: "ended",
      },
    ],
    { workspaceId }
  );
  assert.deepEqual(keys.sort(), [
    roomKey(userA, "lc-lee-call"),
    roomKey(userB, "lc-kamm-call"),
  ].sort());
});

test("Recall metadata and transcript are extracted together", () => {
  const utterance = extractUtterance({
    data: {
      bot: {
        id: "bot-1",
        metadata: {
          session_id: "lc-test-room",
          owner_id: "11111111-1111-4111-8111-111111111111",
          workspace_id: "33333333-3333-4333-8333-333333333333",
        },
      },
      data: {
        text: "  hello there  ",
        participant: { name: "Lee", is_host: true },
      },
    },
  });
  assert.equal(utterance.botId, "bot-1");
  assert.equal(utterance.sessionId, "lc-test-room");
  assert.equal(utterance.text, "hello there");
  assert.equal(utterance.role, "host");
});

test("token hashes are deterministic and never retain the raw token", () => {
  const hash = hashStreamToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash.includes(token), false);
  assert.equal(validSessionId("lc-test-room"), true);
  assert.equal(validWebhookToken(token), true);
  assert.equal(validWebhookToken("short"), false);
});

test("a transcript must match the bot, user, workspace and call", () => {
  const scope = {
    botId: "bot-1",
    sessionId: "lc-test-room",
    ownerId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "33333333-3333-4333-8333-333333333333",
  };
  const utterance = {
    botId: scope.botId,
    sessionId: scope.sessionId,
    metadataOwnerId: scope.ownerId,
    metadataWorkspaceId: scope.workspaceId,
  };
  assert.equal(utteranceMatchesScope(utterance, scope), true);
  assert.equal(
    utteranceMatchesScope(
      { ...utterance, metadataOwnerId: "22222222-2222-4222-8222-222222222222" },
      scope
    ),
    false
  );
});
