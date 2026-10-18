import { z } from 'zod';

/**
 * Content limits. They exist because of WhatsApp/Twilio constraints:
 *  - Twilio rejects message bodies over 1600 characters. Item text is capped well below that
 *    because the lesson header/footer are added on top of it.
 *  - A WhatsApp message can carry only ONE media object, and every lesson item becomes at
 *    least one message. Lessons are delivered inside the webhook request (Twilio waits ~15 s),
 *    so the number of items per lesson is capped.
 */
export const LIMITS = {
  courseTitleMax: 100,
  lessonTitleMax: 80,
  descriptionMax: 500,
  textMax: 1200,
  quizExplanationMax: 1000,
  captionMax: 800,
  labelMax: 100,
  urlMax: 500,
  slugMax: 60,
  itemsPerLessonMax: 6,
  lessonsPerCourseMax: 50,
} as const;

export const MEDIA_KINDS = ['image', 'document', 'video', 'audio'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * File extensions accepted per media kind, taken from Twilio's "Accepted content types for
 * media" table (WhatsApp column). Deliberately narrower than that table: webp is excluded
 * because Twilio documents it as sticker-only. Twilio validates the real Content-Type header
 * when sending, so an extension here is only a first, cheap sanity check; URLs without an
 * extension (e.g. signed URLs) are allowed.
 */
export const MEDIA_EXTENSIONS: Record<MediaKind, readonly string[]> = {
  image: ['jpg', 'jpeg', 'png'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'],
  video: ['mp4'],
  audio: ['mp3', 'ogg', 'amr', '3gp'],
};

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Twilio fetches media from the public internet, so private/loopback hosts can never work. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function fileExtension(url: URL): string | null {
  const last = url.pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : null;
}

const mediaUrl = z
  .string({ error: 'url is required' })
  .trim()
  .max(LIMITS.urlMax, `url must be at most ${LIMITS.urlMax} characters`)
  .refine((v) => parseUrl(v)?.protocol === 'https:', 'url must be a valid https:// URL')
  .refine((v) => {
    const u = parseUrl(v);
    return u !== null && !isPrivateHost(u.hostname);
  }, 'url must be publicly reachable (no localhost or private addresses)');

const linkUrl = z
  .string({ error: 'url is required' })
  .trim()
  .max(LIMITS.urlMax, `url must be at most ${LIMITS.urlMax} characters`)
  .refine((v) => {
    const p = parseUrl(v)?.protocol;
    return p === 'https:' || p === 'http:';
  }, 'url must be a valid http(s) URL');

const caption = z
  .string()
  .trim()
  .max(LIMITS.captionMax, `caption must be at most ${LIMITS.captionMax} characters`)
  .optional();

function mediaItem<K extends MediaKind>(kind: K) {
  return z
    .strictObject({ kind: z.literal(kind), url: mediaUrl, caption })
    .superRefine((item, ctx) => {
      const u = parseUrl(item.url);
      const ext = u ? fileExtension(u) : null;
      if (ext && !MEDIA_EXTENSIONS[kind].includes(ext)) {
        ctx.addIssue({
          code: 'custom',
          path: ['url'],
          message: `.${ext} is not a supported ${kind} type (allowed: ${MEDIA_EXTENSIONS[kind].join(', ')})`,
        });
      }
    });
}

const quizOption = z.object({
  label: z.string().trim().min(1).max(LIMITS.labelMax),
  /** Mark the right answer. At most one option may be correct; a quiz with none is unscored. */
  correct: z.boolean().optional(),
});

const quizItem = z
  .strictObject({
    kind: z.literal('quiz'),
    caption: z.string().trim().min(1).max(LIMITS.textMax),
    explanation: z
      .string()
      .trim()
      .max(
        LIMITS.quizExplanationMax,
        `explanation must be at most ${LIMITS.quizExplanationMax} characters`,
      )
      .nullable()
      .optional(),
    options: z.array(quizOption).min(2).max(4),
  })
  .superRefine((item, ctx) => {
    const labels = item.options.map((o) => o.label.trim().toLowerCase());
    const unique = new Set(labels);
    if (unique.size !== labels.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Quiz option labels must be unique',
      });
    }
    if (item.options.filter((o) => o.correct).length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only one quiz option can be marked correct',
      });
    }
  });

export const lessonItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: z
      .string({ error: 'text is required' })
      .trim()
      .min(1, 'text must not be empty')
      .max(LIMITS.textMax, `text must be at most ${LIMITS.textMax} characters`),
  }),
  mediaItem('image'),
  mediaItem('document'),
  mediaItem('video'),
  mediaItem('audio'),
  z.strictObject({
    kind: z.literal('link'),
    url: linkUrl,
    label: z
      .string()
      .trim()
      .max(LIMITS.labelMax, `label must be at most ${LIMITS.labelMax} characters`)
      .optional(),
  }),
  quizItem,
]);
export type LessonItem = z.infer<typeof lessonItemSchema>;

const lessonTitle = z
  .string({ error: 'title is required' })
  .trim()
  .min(1, 'title must not be empty')
  .max(LIMITS.lessonTitleMax, `title must be at most ${LIMITS.lessonTitleMax} characters`);

const lessonItems = z
  .array(lessonItemSchema)
  .min(1, 'a lesson needs at least one item')
  .max(LIMITS.itemsPerLessonMax, `a lesson can have at most ${LIMITS.itemsPerLessonMax} items`);

export const lessonCreateSchema = z.strictObject({ title: lessonTitle, items: lessonItems });
export type LessonCreateInput = z.infer<typeof lessonCreateSchema>;

export const lessonUpdateSchema = z
  .strictObject({ title: lessonTitle.optional(), items: lessonItems.optional() })
  .refine((v) => v.title !== undefined || v.items !== undefined, 'provide title and/or items');
export type LessonUpdateInput = z.infer<typeof lessonUpdateSchema>;

const courseTitle = z
  .string({ error: 'title is required' })
  .trim()
  .min(1, 'title must not be empty')
  .max(LIMITS.courseTitleMax, `title must be at most ${LIMITS.courseTitleMax} characters`);

const courseDescription = z
  .string()
  .trim()
  .max(LIMITS.descriptionMax, `description must be at most ${LIMITS.descriptionMax} characters`);

// Must contain a letter, so a slug can never be mistaken for a numeric course id.
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .max(LIMITS.slugMax)
  .regex(
    /^(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'slug may contain only a-z, 0-9 and single hyphens, and needs at least one letter',
  );

export const courseCreateSchema = z.strictObject({
  title: courseTitle,
  description: courseDescription.default(''),
  slug: slug.optional(),
  lessons: z
    .array(lessonCreateSchema)
    .max(LIMITS.lessonsPerCourseMax, `at most ${LIMITS.lessonsPerCourseMax} lessons per course`)
    .default([]),
});
export type CourseCreateInput = z.infer<typeof courseCreateSchema>;

export const courseUpdateSchema = z
  .strictObject({ title: courseTitle.optional(), description: courseDescription.optional() })
  .refine(
    (v) => v.title !== undefined || v.description !== undefined,
    'provide title and/or description',
  );
export type CourseUpdateInput = z.infer<typeof courseUpdateSchema>;

// ---- Read models -------------------------------------------------------------------------

export type CourseStatus = 'draft' | 'published';

export interface Course {
  id: number;
  orgId: number;
  slug: string;
  title: string;
  description: string;
  status: CourseStatus;
  lessonCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Lesson {
  id: number;
  courseId: number;
  position: number;
  title: string;
  items: LessonItem[];
}

export interface CourseDetail extends Course {
  lessons: Lesson[];
}

export type EnrollmentStatus = 'pending' | 'active' | 'paused' | 'completed';

export interface Enrollment {
  id: number;
  orgId: number;
  userId: string;
  courseId: number;
  status: EnrollmentStatus;
  lastDeliveredPosition: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  consentAt: string | null;
  consentSource: 'web_registration' | 'admin_attestation' | null;
  consentAdminId: number | null;
}

/** An enrollment joined with the bits of its course the bot needs to talk about it. */
export interface EnrollmentSummary extends Enrollment {
  courseTitle: string;
  lessonCount: number;
}
