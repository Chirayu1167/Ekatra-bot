# Reference repo notes (read-only)

Source: zips in project root, unzipped to `./reference/` for reading only.
Nothing was copied into the bot in Phase 1 and no secrets were copied anywhere.
Paths below are relative to `./reference/`.

## 1. microlearn-v2 (`microlearn-v2/microlearn-v2-main`)

What it does: full learning platform with course authoring, learner messaging over
WhatsApp and Telegram, user management and engagement analytics. Admin works in a web
portal (login, dashboard, courses, visual course editor with WhatsApp preview,
users, Telegram/WhatsApp integration screens, analytics, chat history, settings).

Stack: React 18 + TypeScript + Vite + Tailwind + shadcn/Radix UI, React Query,
React Router; backend is Supabase (Postgres, Auth, Edge Functions for
`whatsapp-api`, `telegram-webhook`, `ai-tutor`, embeddings); WhatsApp via WATI
Business API, Telegram via Bot API.

What the bot does not have yet: Telegram channel; any admin UI (course editor,
preview, users/roles, analytics dashboards, chat history); analytics
(`analytics` table + recharts); user roles (`user_roles`, profiles); day/paragraph
content model (`courses` → `course_days` → `course_paragraphs` vs our
courses → lessons → items); Supabase Auth/RBAC; edge-function webhook handlers.

Reusable later: admin screen flows (Courses/CourseEditor/Users/Analytics pages) as
requirements for the Phase 3 React admin; WhatsApp preview component idea;
role model; `find-similar-resources` + embeddings pattern for a future
retrieval-grounded tutor. Note: a committed `.env` exists at
`microlearn-v2/microlearn-v2-main/.env` (variable names only:
`VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_URL` —
frontend publishable values, no live secret rotation indicated, but the file should
never have been committed; their `.gitignore` only ignores `*.local`).

## 2. cop-main-v2 (`cop-main-v2/cop-main-v2-main`)

What it does: AI micro-course generator + WhatsApp delivery. Generates 3-day
courses (3 modules/day) with Azure OpenAI-class models, stores students and course
content in Airtable, delivers lessons over WhatsApp via the WATI API, converts
lesson text to speech (MP3) and sends completion certificates as PDFs.

Stack: Node 18 + Express 4 (ESM), Airtable SDK, WATI REST API, Azure OpenAI /
HuggingFace / Together AI, Microsoft Cognitive Services Speech (TTS), Azure Blob
for images, canvas + ffmpeg for media, pdfkit for certificates.

What the bot does not have yet: AI course generation; text-to-speech audio
lessons; WATI interactive buttons/lists/template sends; Airtable as a store;
image vision analysis via Blob upload; multi-day drip scheduling as implemented
here (`outroflow.js`, `course_status.js`).

Reusable later: TTS pipeline shape (`textToSpeechAz.js` → MP3 → WhatsApp send —
the closest existing answer to "audio lessons"); `certificate.js` PDF approach to
compare with our `certificate.service.ts`; course-generation prompts in
`OpenAI.js` for the Phase 4 AI-generation work package; `wati.js` as a reference
for template/media sends if we ever support WATI alongside Twilio.

## 3. ek-ai4bharat-kiro (`ek-ai4bharat-kiro/ek-ai4bharat-kiro-main`)

What it does: "Socrates-EK" WhatsApp learning platform for AI4Bharat: Twilio
WhatsApp front end, MongoDB state, AWS Bedrock (Llama 3) course generation,
PDF certificates, progress tracking, with logging/monitoring/security hardening
and Docker packaging. Closest in spirit to our bot (Twilio + Express + bot flows).

Stack: Node 18 + Express 4, Mongoose/MongoDB, Twilio API, AWS Bedrock + S3,
Cloudinary, Winston, `express-rate-limit`, `helmet`, `node-cron`, `validator`,
Jest, Dockerfile + docker-compose, `.env.template`.

What the bot does not have yet: AI course generation (Bedrock); scheduled/drip
delivery (`node-cron` + `flows/courseFlow.js`); webhook rate limiting;
security headers; structured monitoring (`utils/monitoring.js`); S3/Cloudinary
media uploads; external admin dashboard (live demo linked in README);
Mongoose-based multi-instance state.

Reusable later: cron-based scheduling pattern for Phase 2 durable delivery;
`express-rate-limit` + `helmet` + `validation.js` for the tenant/role security
phase; `monitoring.js` + Winston shape for operations; Dockerfile/compose as a
second opinion on ours; `courseFlow.js` state machine for resume/retry semantics.
Uses `.env.template` correctly (no committed `.env` found) — the pattern we
follow with `.env.example`.
