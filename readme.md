# LiveCoach Meet worker

A tiny always-on service that bridges **Recall.ai → the LiveCoach call page**.

```
Recall (webhook)  -->  THIS WORKER  -->  call page  (websocket, live)
                                    \->  Supabase    (persistence / refresh recovery)
```

Recall sends each finalised utterance to `POST /webhook/recall`. The worker
verifies it, ACKs immediately, then relays it to any browser connected on
`/ws?session=<room>` and inserts it into the `meet_utterances` table.

This service does **not** hold the Recall API key — it only receives and
relays. The key lives in the Vercel app, which dispatches the bot (Stage C).

## Endpoints

- `POST /webhook/recall` — Recall posts `transcript.data` here.
- `GET  /ws?session=<room>` — the call page connects here for live utterances.
- `GET  /healthz` — health check.

## Environment variables

| Variable | What it is | Where to get it |
|---|---|---|
| `RECALL_WEBHOOK_SECRET` | Workspace verification secret (signs webhooks) | Recall dashboard → Webhooks / verification secret |
| `SUPABASE_URL` | Your Supabase project URL | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (server-only, never in a browser) | Supabase → Project Settings → API |
| `PORT` | Port to listen on | **Set automatically by Railway — don't add it** |

> The worker runs fine without the secret/Supabase vars (it warns and skips
> verification / persistence), but set all three before real use.

## Deploy on Railway

1. Put these three files (`index.js`, `package.json`, this README) in a **new
   GitHub repo** — separate from the `livecoach` app. (Use GitHub's "Add file →
   Upload files" like you do for the main app.)
2. Go to **railway.app** → sign in with GitHub → **New Project** →
   **Deploy from GitHub repo** → pick the new repo.
3. Railway detects Node and runs `npm install` then `npm start` automatically.
4. Open the service → **Variables** tab → add `RECALL_WEBHOOK_SECRET`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. (Leave `PORT` alone.)
5. Open **Settings → Networking → Generate Domain** to get a public URL, e.g.
   `https://livecoach-meet-worker-production.up.railway.app`.
6. That domain is what the rest of the system uses:
   - Webhook URL (given to Recall when dispatching the bot): `https://<domain>/webhook/recall`
   - Browser websocket (used by the call page): `wss://<domain>/ws?session=<room>`

After deploy, hit `https://<domain>/` in a browser — it should say
"LiveCoach Meet worker: up".
