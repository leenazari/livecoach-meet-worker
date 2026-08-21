# LiveCoach Meet worker

A tiny always-on service that bridges **Recall.ai → the LiveCoach call page**.

```
Recall (webhook)  -->  THIS WORKER  -->  call page  (websocket, live)
                                    \->  Supabase    (persistence / refresh recovery)
```

Recall sends each finalised utterance to a per-bot `POST /webhook/recall` URL.
The worker verifies its short-lived private token before parsing the payload,
then checks the bot, user, workspace and call metadata together. It relays only
to a browser holding a separate private stream token for that same user and
call. Every saved utterance carries the verified owner and workspace.

This service does **not** hold the Recall API key — it only receives and
relays. The key lives in the Vercel app, which dispatches the bot (Stage C).

## Endpoints

- `POST /webhook/recall` — Recall posts `transcript.data` here.
- `GET  /ws?session=<room>` — requires the `livecoach-v1` and
  `livecoach-token.<opaque token>` websocket subprotocols.
- `GET  /healthz` — health check.

## Environment variables

| Variable | What it is | Where to get it |
|---|---|---|
| `RECALL_WORKSPACE_VERIFICATION_SECRET` | Optional second layer of Recall workspace signature verification | Recall dashboard → API keys and secrets |
| `SUPABASE_URL` | Your Supabase project URL | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (server-only, never in a browser) | Supabase → Project Settings → API |
| `PORT` | Port to listen on | **Set automatically by Railway — don't add it** |

The health endpoint returns `503` and no webhook or transcript connection is
accepted if either Supabase variable is missing. Per-bot and browser tokens are
always mandatory. The optional Recall secret adds a second verification layer.

## Deploy on Railway

1. Connect Railway to the `livecoach-meet-worker` GitHub repository.
2. Deploy the repository's `main` branch.
3. Railway detects Node and runs `npm install` then `npm start` automatically.
4. Open the service → **Variables** tab → add `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY`. Add `RECALL_WORKSPACE_VERIFICATION_SECRET` when
   it is available. Leave `PORT` alone.
5. Open **Settings → Networking → Generate Domain** to get a public URL, e.g.
   `https://livecoach-meet-worker-production.up.railway.app`.
6. That domain is what the rest of the system uses:
   - Webhook URL (given to Recall when dispatching the bot): `https://<domain>/webhook/recall`
   - Browser websocket (used by the call page): `wss://<domain>/ws?session=<room>`
     with a user and session-bound token created by LiveCoach.

After deploy, hit `https://<domain>/` in a browser — it should say
"LiveCoach Meet worker: up".
