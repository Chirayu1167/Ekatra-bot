# Course model mapping

The admin console creates and edits courses through the Ekatra admin API. It does not read,
import, or write the reference dashboard's Supabase data. No reference course values or
environment files are copied.

| Dashboard field/model | Ekatra model | Mapping |
| --- | --- | --- |
| Course title, description | `courses.title`, `courses.description` | Direct. |
| Course draft/active status | `courses.status` (`draft`/`published`) | `active` maps to `published`; draft remains draft. Publishing requires at least one lesson. |
| Day/module order and title | `lessons.position`, `lessons.title` | Adapter: one ordered day/module becomes one sequential lesson. Pacing is configured separately through schedule endpoints. |
| Day/module id | `lessons.id` | Not copied: the dashboard uses UUIDs while Ekatra assigns integer lesson ids. No Supabase records are imported. When editing an Ekatra lesson, its existing id is retained by `PUT /admin/courses/:id/lessons/:lessonId`; lesson positions are not reordered. |
| Paragraph/resource id, text, order | `lesson_items` text item | Adapter: each paragraph becomes one ordered `text` item. Paragraph text and sequence are retained; reference resource ids are not imported. |
| Optional day media URL | `lesson_items` media/link item | Needs adapter: represent a supplied URL as a `link` item when it is a general URL; use an explicit supported media kind when the author supplies one. The source stores only a URL and does not identify media kind, so the UI must not silently claim a media attachment or infer one from a signed URL. The URL itself remains available as a link. |
| Quiz question | Quiz `caption` | Direct after naming adaptation. |
| Quiz options and `correct_answer` | `options[].label` and `options[].correct` | Adapter: match the reference correct answer to its option and set its correct flag. |
| Quiz explanation | `lesson_items.explanation` (nullable `TEXT`, max 1000 characters) | Preserved via append-only PostgreSQL migration v5. Admin API trims, validates, and returns it on course create/read/edit; optional SQLite imports preserve it and older sources import NULL. Existing quiz interactions append this one field to the existing correct/incorrect reply; no extra item/message or change to positions, idempotency, progress, or retries. The dashboard model inspected exposes one explanation field, not separate correct/incorrect feedback fields. |
| Publish/unpublish | `POST /admin/courses/:id/publish`, `/unpublish` | Direct. Unpublishing returns the course to draft; content remains stored. |
| Price, category, Stripe fields, instructor, language, enrollment/completion counters | No Ekatra course field | Not supported by the bot course model; omitted from the console per Phase 4 scope. No source course data is imported. |
| Telegram/web channel and web enrollment mode | Twilio WhatsApp delivery only | Not supported; excluded because Twilio is the decided provider and the learner web experience is outside this console. Course text/resources are not imported or deleted. |
| Dashboard pacing and pause reminder fields | Course/enrollment/org schedule APIs where representable | Adapter for delivery times and timezone to backend schedules. Pacing-by-day and pause reminders without a backend equivalent are omitted. |
| Custom WhatsApp introduction/completion copy (`whatsappLessonIntro`, `whatsappCompletionMessage`) | No per-course template/copy fields | **Not supported in Stage 1:** Ekatra sends fixed Twilio copy. These fields are hidden from the course editor and are not imported. SQLite import warns by field and course count if non-empty values are present; it never logs the authored message text. Before any Phase 5 course import, check whether the representative course uses these fields and raise a change request if it does. |

The importer uses the explicit `courses` column allowlist in `src/scripts/import-sqlite.ts`.
Every source course column outside that allowlist is treated as unsupported; if any row has a
non-empty value, the importer warns with only the field name, affected row count, and `excluded`
action. This also covers unsupported price/category/Stripe, channel, instructor/language, count,
and pause-reminder columns if they exist in a source database. Values are never included in the
warning. An absent column or an all-empty column has no content to preserve and produces no
warning.

Limits and validation for lesson items come from `src/types/course.ts`. Existing Ekatra lesson ids
must be used on edits; creating a replacement lesson would reset its identity and is not an
acceptable edit strategy. The Part 1 editor exposes supported course title/description, lesson
titles, and typed content items only. It does not expose `whatsappLessonIntro`,
`whatsappCompletionMessage`, price, category, Stripe fields, or other course values without an
Ekatra backend equivalent. Do not discard an unmatched field silently: preserve it only if the
standing Phase 5 rule permits it without changing message-item/progress/delivery semantics;
otherwise hide it and document the exclusion here.
