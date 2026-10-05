# Ekatra WhatsApp Chatbot (MVP)

A small TypeScript/Express service that receives WhatsApp messages through Twilio, runs them through
a simple chatbot, and replies. It is the messaging foundation for the Ekatra learning platform.

**Milestone:** a user sends `hello` on WhatsApp and gets a meaningful reply.

```text
User → WhatsApp → Twilio → POST /webhooks/whatsapp
                              │  1. validate Twilio signature
                              │  2. parse From / To / Body / MessageSid
                              │  3. chatbot.handleMessage()
                              │  4. WhatsApp service → Twilio REST API
                              ▼
                       User receives reply
```

## Quick start

Requires Node.js 20+.

```bash
npm install
cp .env.example .env     # then fill in your Twilio values
npm run dev
```

Check it is up:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

## How to run (local development)

Every time you develop, do these 3 steps in order:

### 1. Start the app server

```bash
npm run dev
```

Leave it running. Confirm it is up with `curl http://localhost:3000/health`.

### 2. Start the Cloudflare tunnel

In a **second terminal** (keep the app running), expose your local server over HTTPS:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a public URL like `https://<something>.trycloudflare.com`.
Keep this terminal open — closing it kills the URL.

Then set that URL in `.env` (no trailing slash) and **restart the app** so
signature validation uses the exact public URL:

```text
PUBLIC_BASE_URL=https://<something>.trycloudflare.com
```

> The free Cloudflare URL changes every time you restart `cloudflared`,
> so you must repeat step 3 each time it changes.

### 3. Update the webhook on your Twilio number

1. Open the [Twilio Console](https://www.twilio.com/console) → Messaging →
   Senders → WhatsApp senders → open your number → **Edit sender**
   (for the sandbox: Messaging → Try it out → Send a WhatsApp message).
2. Find **"When a message comes in"**, set the method to **`POST`**.
3. Set the URL to your current tunnel URL plus the webhook path:

   ```text
   https://<something>.trycloudflare.com/webhooks/whatsapp
   ```

4. Save.
5. From your phone, send `hello` to the Twilio WhatsApp number — you should get
   the bot's reply, and see `whatsapp.message.received` /
   `whatsapp.message.replied` in the app logs.

If replies stop after restarting `cloudflared`, the tunnel URL changed —
copy the new URL into both `.env` (`PUBLIC_BASE_URL`, then restart the app)
and the Twilio sender webhook.

## Environment variables

| Variable                  | Required | Description                                                                                       |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `PORT`                    | no       | HTTP port. Default `3000`.                                                                        |
| `TWILIO_ACCOUNT_SID`      | yes      | Twilio Account SID (starts with `AC`).                                                            |
| `TWILIO_AUTH_TOKEN`       | yes      | Twilio Auth Token. Used to send messages **and** to verify webhook signatures. Keep it secret.    |
| `TWILIO_WHATSAPP_FROM`    | yes      | Your WhatsApp sender, with prefix, e.g. `whatsapp:+14155238886` (the Twilio sandbox number).      |
| `TWILIO_WEBHOOK_VALIDATE` | no       | `true` (default) or `false`. See [Webhook signature validation](#webhook-signature-validation).   |
| `PUBLIC_BASE_URL`         | no       | Public base URL Twilio calls, e.g. `https://abc.ngrok-free.app` (no trailing slash). Recommended. |

Configuration is validated with Zod at startup. If anything required is missing or malformed, the
process prints a clear message (variable names only, never values) and exits with code 1.

`.env` is git-ignored. Never commit real credentials.

## Twilio Setup

1. **Create/access a Twilio account** at <https://www.twilio.com/console>.
2. **Copy your Account SID** from the Console dashboard → `TWILIO_ACCOUNT_SID`.
3. **Copy your Auth Token** from the same dashboard (click to reveal) → `TWILIO_AUTH_TOKEN`.
4. **Configure a WhatsApp sender.** For development use the **WhatsApp Sandbox**
   (Console → Messaging → Try it out → Send a WhatsApp message). The sandbox shows its number
   (usually `+1 415 523 8886`) and a join phrase like `join <two-words>`. From your own WhatsApp,
   send that phrase to the sandbox number to opt in. Set `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886`
   (use the number shown in your console).
5. **Configure the incoming-message webhook.** In the sandbox settings, find
   **"When a message comes in"**.
6. **Set the method to `POST`.**
7. **Set the URL to:**

   ```text
   https://YOUR-DOMAIN/webhooks/whatsapp
   ```

   For local development, `YOUR-DOMAIN` is your tunnel (see below), e.g.
   `https://YOUR-TUNNEL.ngrok-free.app/webhooks/whatsapp`. Save the settings.

8. **Start the application** (`npm run dev`).
9. **Send a WhatsApp message** (e.g. `hello`) to the sandbox number.
10. **Verify the response.** You should receive the welcome message and see
    `whatsapp.message.received` and `whatsapp.message.replied` in the server logs.

### Exposing your local server with ngrok

Twilio must be able to reach your machine over HTTPS:

```bash
ngrok http 3000
```

ngrok prints a forwarding URL such as `https://YOUR-TUNNEL.ngrok-free.app`. Use it in two places:

- Twilio webhook: `https://YOUR-TUNNEL.ngrok-free.app/webhooks/whatsapp` (method `POST`)
- `.env`: `PUBLIC_BASE_URL=https://YOUR-TUNNEL.ngrok-free.app` (restart the app after changing it)

Free ngrok URLs change each time ngrok restarts, so update both when that happens.

## Webhook signature validation

Twilio signs every webhook with the `X-Twilio-Signature` header. This app verifies it using
Twilio's official helper (`twilio.validateRequest`) — no custom algorithm.

| `TWILIO_WEBHOOK_VALIDATE` | Behaviour                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `true` (default)          | Missing/invalid signature → **403**. The chatbot is **not** executed and nothing is sent.                                    |
| `false`                   | Signature is not checked. For local experiments (e.g. `curl`) only. A warning is logged at startup. **Never in production.** |

The signature covers the exact public URL plus the POST parameters. If validation fails even
though your setup looks right, the most common cause is a URL mismatch (the URL Twilio called differs
from the one the app reconstructs). Set `PUBLIC_BASE_URL` to the exact base URL configured in Twilio;
the failing log line (`twilio.signature.invalid`) includes `urlUsedForValidation` to help you compare.
Also note that the Twilio console URL (`http` vs `https`, trailing slash, query string) must match what
Twilio is actually configured to call.

## Bot behaviour

| User sends                    | Bot replies with |
| ----------------------------- | ---------------- |
| `hello`, `hi`, `hey`, `start` | Welcome + menu   |
| `1`                           | Start learning   |
| `2`, `help`                   | Help             |
| anything else (incl. empty)   | Fallback + menu  |

Matching ignores case, surrounding whitespace and trailing punctuation (`Hello!` works).

## Scripts

| Command             | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Run with auto-reload (`tsx watch`)             |
| `npm run build`     | Compile to `dist/`                             |
| `npm start`         | Run the compiled build (`node dist/server.js`) |
| `npm test`          | Run the Vitest suite (Twilio is fully mocked)  |
| `npm run lint`      | ESLint                                         |
| `npm run typecheck` | TypeScript type check (`tsc --noEmit`)         |
| `npm run format`    | Prettier                                       |

Tests never call Twilio. Signature tests generate signatures with Twilio's own
`getExpectedTwilioSignature` helper.

## Project structure

```text
src/
├── config/env.ts                    Zod env validation (fail fast)
├── routes/whatsapp.ts               Route + middleware wiring for /webhooks/whatsapp
├── controllers/whatsapp.controller.ts  Parse → log → chatbot → send → acknowledge
├── middleware/
│   ├── validateTwilioSignature.ts   Official Twilio signature check
│   └── errorHandler.ts              Centralized error → HTTP mapping
├── services/
│   ├── whatsapp.service.ts          Only place that talks to Twilio
│   └── idempotency.ts               IdempotencyStore interface (no-op for now)
├── bot/chatbot.ts                   Pure chatbot logic (no HTTP, no Twilio)
├── types/whatsapp.ts                Webhook schema + shared types
├── errors.ts / logger.ts            Typed errors, structured JSON logger
├── app.ts                           createApp(deps) — dependency-injected Express app
└── server.ts                        Entry point
```

Responsibilities:

```text
Webhook Controller → MessageHandler (Chatbot) → WhatsAppSender (Twilio service) → Twilio
```

## Design notes for what comes next

- **Replace the chatbot with a Learning Engine.** The controller depends only on the
  `MessageHandler` interface (`handleMessage({ userId, text, messageId })`). A Learning Engine that
  implements it can be dropped into `server.ts` without touching the webhook layer.
- **Replace the sender with a queue.** The controller depends only on `WhatsAppSender`. Later,
  the webhook can enqueue work (Redis/worker) and a worker can send via the Twilio service.
- **Idempotency.** `MessageSid` will become the idempotency key in the persistent implementation.
  The controller already calls `IdempotencyStore.claim(messageSid)`; today it is a no-op
  (`NoopIdempotencyStore`), so duplicate webhooks are **not** deduplicated yet. Even with a
  persistent store, this reduces duplicate processing — it does **not** guarantee exactly-once
  WhatsApp delivery.
- **Webhook latency.** The reply is generated and sent before the webhook returns. Twilio's webhook
  timeout is short (about 15 seconds), which is fine for today's instant replies but is a reason to
  move to a queue/worker once logic gets slower.

## Error handling

All errors go through one handler. Clients receive `{ "error": { "code", "message" } }` and never a
stack trace, Twilio error detail, or configuration value.

| Situation                        | HTTP | `error.code`             |
| -------------------------------- | ---- | ------------------------ |
| Malformed webhook / bad body     | 400  | `bad_request`            |
| Invalid/missing Twilio signature | 403  | `invalid_signature`      |
| Chatbot threw                    | 500  | `chatbot_error`          |
| Twilio send failed               | 502  | `twilio_send_failed`     |
| Unknown route                    | 404  | `not_found`              |
| Missing/invalid configuration    | —    | process exits at startup |

WhatsApp users never see error details; if sending fails, they simply get no reply and the failure is logged.

## Logging

Logs are one JSON object per line. For each incoming message the app logs `timestamp`, `messageSid`,
`from`, `to` and `messageBody`. The Auth Token and other secrets are never logged.

> **Privacy note:** `from` is a phone number and `messageBody` is user-written text, so these logs contain
> personal data. That is useful while debugging; revisit retention and redaction before handling real learners.

## Limitations (by design for the MVP)

- No database, queue, auth, or AI — see the "next" notes above.
- No deduplication of repeated webhooks yet (no-op idempotency store).
- WhatsApp rules still apply: with the sandbox you must opt in first, and free-form replies are only
  allowed within Twilio/WhatsApp's customer-service window after the user's last message.
