# Twilio WhatsApp setup runbook

This runbook is for a staging environment and test numbers only. Do not send a message until a
human has confirmed the selected Twilio account, sender, recipient, and approved templates.
Twilio is the only supported provider.

## Webhook URLs

Configure the WhatsApp sender's inbound-message webhook as:

```text
POST https://<public-host>/webhooks/whatsapp
```

The status callback endpoint is:

```text
POST https://<public-host>/webhooks/whatsapp/status
```

Both endpoints validate `X-Twilio-Signature`. The current sender integration does not set a
per-message `statusCallback` parameter when creating outbound messages, so delivery-status
callbacks are not automatically subscribed to by the sender yet. Do not treat the status endpoint
as proof of delivery until outbound callback registration is implemented and verified.

Set `PUBLIC_BASE_URL` to the exact externally visible origin, for example
`https://staging.example.invalid` (no path or trailing slash). Signature validation signs that
origin plus the original request path and query. The fallback derives protocol and host from
Express's trusted one-hop proxy handling. `src/app.ts` sets `trust proxy` to one hop, and the
signature regression test verifies proxy-derived `X-Forwarded-Proto` and `X-Forwarded-Host`.
Configure the TLS-terminating proxy to overwrite those headers and ensure the app cannot be
reached directly from untrusted clients. Prefer the fixed `PUBLIC_BASE_URL` in staging and
production so an origin mismatch cannot invalidate every webhook.

## WhatsApp sandbox

1. In Twilio Console, open **Messaging → Try it out → Send a WhatsApp message** and note the
   sandbox sender and join phrase.
2. Set `TWILIO_WHATSAPP_FROM` to `whatsapp:+<sandbox-number>` and provide the account SID/token
   and `PUBLIC_BASE_URL` through the deployment's secret manager/environment.
3. From an authorized test handset, send the sandbox's `join <code>` phrase.
4. Set the sender's inbound webhook to the URL above with method `POST`.
5. Run `npm run staging:smoke` with `BASE_URL` and `ADMIN_KEY` set, then follow the staging
   checklist. Use only test learners and obtain consent before enrollment.

## Scheduled-message quick-reply template

When a scheduled lesson falls outside WhatsApp's 24-hour customer-service window, the service
uses `TWILIO_CONTENT_SID_SCHEDULE` instead of sending lesson content. Create a Meta-approved
WhatsApp utility template in Twilio Content with a clear lesson-ready prompt and a quick-reply
button. Set that button's **payload / ID to exactly `NEXT`**; the inbound handler treats
`ButtonPayload` as the command, and only `NEXT` advances the lesson. The content must be approved
for business-initiated messages and use the corresponding Content SID (typically `HX` followed
by 32 hexadecimal characters). Configure the SID in the secret manager/environment, never in
source control. Without a configured SID, a closed-window scheduled send becomes a visible
`template_required` failure rather than silently sending an unapproved free-form message.

The application intentionally does not create or approve templates automatically. Check that
the approved content and quick-reply payload match the configured SID before enabling schedules.

## STOP, START, and failures

- Send `STOP` from the opted-in test handset. Expect the opt-out confirmation, followed by no
  course messages. Verify the learner is opted out in the admin console without exposing the
  full number.
- Send `START` from the same handset to restore consent according to the provider's sandbox
  behavior, then confirm the bot's reply. Never use this procedure to override a person's
  withdrawal of consent outside an explicit new opt-in.
- Open `/console` → **Failures** to inspect a delivery failure, its attempts and retry state.
  Use **Replay** only after correcting the cause; otherwise discard with a reason. A resend can
  contact a real person, so staging/live replay requires an explicit operational check.
- A template rejection, opt-out, permanent recipient error, or unknown provider outcome must
  remain visible as a failure. Do not mark a message delivered manually to make the console
  appear green.

## Verification boundary

The local fake-sender and API tests do not contact Twilio. They cover signature rejection,
schedule-template handling, idempotency, and failure/replay behavior at the application boundary.
Real sandbox join, template approval/rendering, handset ordering, STOP/START, and Twilio webhook
signatures remain unverified until a human runs the live journey checklist with approved test
numbers.
