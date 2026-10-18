/**
 * Quick-reply Content Templates the bot uses. Each is a message body ({{1}}, filled in
 * per message) plus tap-buttons. A tap comes back as an inbound message whose Body is the
 * button title and whose ButtonPayload is the button id; both are the command word, so a tap
 * behaves exactly like typing it.
 *
 * In-session (within 24 h of the learner's message) quick-reply templates need no WhatsApp
 * approval, but are limited to 3 buttons. Keep every set at 3 or fewer.
 */
export interface ButtonTemplateSpec {
  friendlyName: string;
  /** The .env variable that holds this template's SID. */
  envVar: string;
  buttons: { title: string; id: string }[];
  /** Template body. Defaults to `{{1}}` (the message text is the variable). */
  body?: string;
  /** Sample value for {{1}}, required by WhatsApp when the template is submitted for approval. */
  sample?: string;
  /**
   * Submit to WhatsApp for approval after creating. Needed for any template sent OUTSIDE the
   * 24 h window after the learner's last message, and such a template may not be only `{{1}}`.
   */
  whatsappApproval?: { name: string; category: 'UTILITY' | 'MARKETING' };
}

/** Business-initiated message sent right after web registration. Needs WhatsApp approval. */
export const WELCOME_BUTTON_TEMPLATE: ButtonTemplateSpec = {
  friendlyName: 'ekatra_welcome',
  envVar: 'TWILIO_CONTENT_SID_WELCOME',
  body: "Hi! You're registered for {{1}} on Ekatra. Tap Start Course whenever you're ready to begin.",
  sample: 'Python Basics',
  buttons: [{ title: 'Start Course', id: 'START_COURSE' }],
  whatsappApproval: { name: 'ekatra_welcome', category: 'UTILITY' },
};

/** Templates used by CourseBot (course commands) — all buttons must be valid parseCommand inputs. */
export const COURSE_BUTTON_TEMPLATES: readonly ButtonTemplateSpec[] = [
  {
    friendlyName: 'ekatra_nav',
    envVar: 'TWILIO_CONTENT_SID_NAV',
    buttons: [
      { title: 'Next', id: 'NEXT' },
      { title: 'Pause', id: 'PAUSE' },
    ],
  },
  {
    friendlyName: 'ekatra_resume',
    envVar: 'TWILIO_CONTENT_SID_RESUME',
    buttons: [{ title: 'Resume', id: 'RESUME' }],
  },
  {
    friendlyName: 'ekatra_start_course',
    envVar: 'TWILIO_CONTENT_SID_START_COURSE',
    buttons: [{ title: 'Start Course', id: 'START_COURSE' }],
  },
  {
    friendlyName: 'ekatra_courses',
    envVar: 'TWILIO_CONTENT_SID_COURSES',
    buttons: [{ title: 'Courses', id: 'COURSES' }],
  },
  {
    friendlyName: 'ekatra_cmds_1',
    envVar: 'TWILIO_CONTENT_SID_CMDS_1',
    buttons: [
      { title: 'Courses', id: 'COURSES' },
      { title: 'Next', id: 'NEXT' },
      { title: 'Pause', id: 'PAUSE' },
    ],
  },
  {
    friendlyName: 'ekatra_cmds_2',
    envVar: 'TWILIO_CONTENT_SID_CMDS_2',
    buttons: [
      { title: 'Resume', id: 'RESUME' },
      { title: 'Progress', id: 'PROGRESS' },
      { title: 'Courses', id: 'COURSES' },
    ],
  },
  {
    friendlyName: 'ekatra_quiz',
    envVar: 'TWILIO_CONTENT_SID_QUIZ',
    buttons: [
      { title: 'A', id: 'A' },
      { title: 'B', id: 'B' },
      { title: 'C', id: 'C' },
    ],
  },
];

/** Templates used by Chatbot (main menu) — buttons map to Chatbot's direct handlers ("1", "2"). */
export const CHATBOT_BUTTON_TEMPLATES: readonly ButtonTemplateSpec[] = [
  {
    friendlyName: 'ekatra_main_menu',
    envVar: 'TWILIO_CONTENT_SID_MAIN_MENU',
    buttons: [
      { title: '1', id: '1' },
      { title: '2', id: '2' },
    ],
  },
];

/** All templates combined for setup script. */
export const BUTTON_TEMPLATES: readonly ButtonTemplateSpec[] = [
  ...CHATBOT_BUTTON_TEMPLATES,
  ...COURSE_BUTTON_TEMPLATES,
  WELCOME_BUTTON_TEMPLATE,
];

/** The slice of Twilio's Content API this needs (lets tests use a fake). */
export interface ContentApi {
  list(): Promise<{ sid: string; friendlyName: string }[]>;
  create(params: {
    friendlyName: string;
    language: string;
    variables: Record<string, string>;
    types: {
      'twilio/quick-reply': {
        body: string;
        actions: { title: string; id: string; type: 'QUICK_REPLY' }[];
      };
    };
  }): Promise<{ sid: string }>;
}

export interface EnsuredTemplate {
  spec: ButtonTemplateSpec;
  sid: string;
  created: boolean;
}

/** Create any missing templates (matched by friendly name) and return every SID. Idempotent. */
export async function ensureButtonTemplates(content: ContentApi): Promise<EnsuredTemplate[]> {
  const existing = new Map((await content.list()).map((c) => [c.friendlyName, c.sid]));
  const result: EnsuredTemplate[] = [];
  for (const spec of BUTTON_TEMPLATES) {
    const found = existing.get(spec.friendlyName);
    if (found) {
      result.push({ spec, sid: found, created: false });
      continue;
    }
    const made = await content.create({
      friendlyName: spec.friendlyName,
      language: 'en',
      variables: { '1': spec.sample ?? 'Ready for the next step?' },
      types: {
        'twilio/quick-reply': {
          body: spec.body ?? '{{1}}',
          actions: spec.buttons.map((b) => ({ title: b.title, id: b.id, type: 'QUICK_REPLY' as const })),
        },
      },
    });
    result.push({ spec, sid: made.sid, created: true });
  }
  return result;
}
