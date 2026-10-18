import { silentLogger, type Logger } from '../logger';
import type { ReplyMessage } from '../services/delivery';
import type { CourseService } from '../services/course.service';
import type { EnrollmentService } from '../services/enrollment.service';
import type { OptOutService } from '../services/optout.service';
import type { CertificateService } from '../services/certificate.service';
import type { CourseTutor } from '../services/courseTutor';
import type { OrganisationsService } from '../services/organisations.service';
import type { EnrollmentStatus, EnrollmentSummary, LessonItem } from '../types/course';
import { pdfSupported } from '../routes/certificates';
import type { ChatbotInput, ChatbotReply, DeliveryAction, MessageHandler } from './chatbot';
import { parseCommand, parseKeyword } from './commands';
import { renderLesson } from './lessonRenderer';

export const COMMAND_HELP = [
  'Course commands:',
  'COURSES – see available courses',
  'START <number> – begin a course',
  'NEXT – get the next lesson',
  'PAUSE / RESUME – pause or continue',
  'PROGRESS – see how far you are',
  'CERTIFICATE – get your certificate after finishing a course',
  'Or just type a question about your course and I\'ll answer it.',
].join('\n');

const MAX_COURSES_LISTED = 10;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
const say = (text: string): ChatbotReply => ({ text });

function fromMessages(
  messages: ReplyMessage[],
  onDelivered?: () => void | Promise<void>,
  deliveryAction?: DeliveryAction,
): ChatbotReply {
  const [first, ...rest] = messages;
  return {
    text: first?.text ?? '',
    ...(first?.mediaUrl && { mediaUrl: first.mediaUrl }),
    // Preserve tap-buttons when the first message carries them; dropping them here would
    // silently downgrade a button message to plain text.
    ...(first?.contentSid && { contentSid: first.contentSid }),
    ...(first?.fallbackText && { fallbackText: first.fallbackText }),
    ...(first?.optOutConfirmation && { optOutConfirmation: true as const }),
    ...(rest.length > 0 && { followUps: rest }),
    ...(onDelivered && { onDelivered }),
    ...(deliveryAction && { deliveryAction }),
  };
}

const stopConfirmation = (text: string): ChatbotReply => ({ text, optOutConfirmation: true });

export interface CertificateMessageDeps {
  certificates: CertificateService;
  publicBaseUrl: string | undefined;
  learnerName: (userId: string) => string | Promise<string>;
}

/**
 * The WhatsApp messages that deliver a certificate for a (completed or
 * completing) enrollment. Shared by the inbound bot and the scheduler so both
 * send the same certificate payload.
 */
export async function certificateMessagesFor(
  deps: CertificateMessageDeps,
  enrollment: EnrollmentSummary,
): Promise<ReplyMessage[]> {
  const name = await deps.learnerName(enrollment.userId);
  const greeting = `🎓 Congratulations${name ? `, ${name}` : ''}! You've completed *${enrollment.courseTitle}*.`;
  if (!deps.publicBaseUrl) return [{ text: `${greeting} Your completion has been recorded.` }];
  const code = deps.certificates.codeFor(enrollment.id);
  const base = `${deps.publicBaseUrl}/certificates/${code}`;
  const asPdf = pdfSupported({ learnerName: name || 'Learner', courseTitle: enrollment.courseTitle });
  return asPdf
    ? [{ text: `${greeting} Here's your certificate.`, mediaUrl: `${base}.pdf` }]
    : [{ text: `${greeting} View and print your certificate here:\n${base}` }];
}

/** Twilio Content Template SIDs for tap-buttons. Each is optional and independent. */
export interface ButtonTemplates {
  next?: string | undefined;
  resume?: string | undefined;
  startCourse?: string | undefined;
  courses?: string | undefined;
  cmds1?: string | undefined;
  cmds2?: string | undefined;
  quiz?: string | undefined;
  /** Course selection templates (paginated, max 3 courses each) */
  courseSelect?: string[];
}

/** Context for smart button selection. */
export interface ButtonContext {
  /** Type of message being sent. */
  messageType: 'lesson' | 'command_response' | 'error' | 'welcome' | 'completion' | 'pause_prompt';
  /** Current lesson number (for lesson messages). */
  lessonNumber?: number;
  /** Total lessons in course. */
  lessonCount?: number;
  /** Whether this is the final lesson. */
  isFinalLesson?: boolean;
  /** Active enrollment if any. */
  activeEnrollment?: EnrollmentSummary | null;
  /** Paused enrollment if any. */
  pausedEnrollment?: EnrollmentSummary | null;
  /** Pending enrollment if any (pre-enrolled but not started). */
  pendingEnrollment?: EnrollmentSummary | null;
  /** Completed enrollments. */
  completedEnrollments?: EnrollmentSummary[];
  /** Pre-computed button state (used when enrollments not in context). */
  buttonState?: ButtonState;
}

/**
 * Learner lifecycle state driving tap-button choice. Derived from enrollments with
 * active > paused > pending > completed > new precedence (a learner with both paused and completed
 * courses is "paused": resuming is the most relevant action).
 * 'pending' means the learner has pre-enrolled via dashboard but hasn't started the course yet.
 */
export type ButtonState = 'new' | 'active' | 'paused' | 'pending' | 'completed';

/** Pure mapping from enrollment statuses to the button state. Exported for tests. */
export function buttonStateForStatuses(statuses: EnrollmentStatus[]): ButtonState {
  if (statuses.includes('active')) return 'active';
  if (statuses.includes('paused')) return 'paused';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.length > 0) return 'completed';
  return 'new';
}

export interface CourseBotDeps {
  courses: CourseService;
  enrollments: EnrollmentService;
  optOuts: OptOutService;
  /** Tenant registry. WhatsApp has no auth principal, so the org is resolved from the
   * learner's enrollment state (most recent enrollment's org, else the default org). */
  orgs: OrganisationsService;
  /** Handles everything that is not a course command (the original greeting/help bot). */
  fallback: MessageHandler;
  buttons?: ButtonTemplates;
  logger?: Logger;
  /** Answers questions about the learner's own course only. Omit to switch Q&A off. */
  tutor?: CourseTutor;
  certificates?: CertificateService;
  /** Public base URL used to build certificate links (Twilio must be able to fetch the PDF). */
  publicBaseUrl?: string | undefined;
  /** Display name lookup for certificate messages. */
  learnerName?: (userId: string) => string | Promise<string>;
}

const isGreeting = (text: string) =>
  ['hello', 'hi', 'hey', 'hola', 'namaste'].includes(text.trim().toLowerCase().replace(/[\s!.?,]+$/u, ''));

/**
 * Course delivery on top of the original chatbot.
 *
 * Key rule: a lesson only counts as delivered once the webhook layer reports every message was
 * sent (`onDelivered`). If sending fails, progress is untouched and NEXT simply sends the
 * lesson again, so a learner can see a lesson twice after a failure but can never skip one.
 */
export class CourseBot implements MessageHandler {
  private readonly courses: CourseService;
  private readonly enrollments: EnrollmentService;
  private readonly optOuts: OptOutService;
  private readonly orgs: OrganisationsService;
  private readonly fallback: MessageHandler;
  private readonly buttons: ButtonTemplates;
  private readonly logger: Logger;
  private readonly tutor: CourseTutor | undefined;
  private readonly certificates: CertificateService | undefined;
  private readonly publicBaseUrl: string | undefined;
  private readonly learnerName: (userId: string) => string | Promise<string>;

  constructor(deps: CourseBotDeps) {
    this.courses = deps.courses;
    this.enrollments = deps.enrollments;
    this.optOuts = deps.optOuts;
    this.orgs = deps.orgs;
    this.fallback = deps.fallback;
    this.buttons = deps.buttons ?? {};
    this.logger = deps.logger ?? silentLogger;
    this.tutor = deps.tutor;
    this.certificates = deps.certificates;
    this.publicBaseUrl = deps.publicBaseUrl;
    this.learnerName = deps.learnerName ?? (() => '');
  }

  /**
   * Which org's courses this WhatsApp message is about. The learner's most recently touched
   * enrollment wins (a pending registration selects its org); otherwise the default org.
   * Never taken from client input: there is no client-supplied org on this channel.
   */
  private async resolveOrgId(userId: string): Promise<number> {
    const first = (await this.enrollments.locateUser(userId))[0];
    return first ? first.orgId : this.orgs.getDefaultId();
  }

  /**
   * Load the learner's button state with a single enrollment query (in the resolved org).
   */
  private async resolveButtonState(userId: string): Promise<ButtonState> {
    const orgId = await this.resolveOrgId(userId);
    return buttonStateForStatuses(
      (await this.enrollments.listForUser(orgId, userId, 5)).map((e) => e.status),
    );
  }

  /**
   * Smart button selection based on learner state AND message context.
   * Shows only relevant next actions. Avoids redundant buttons.
   */
  private selectButtonSidForContext(ctx: ButtonContext): string | undefined {
    const { messageType, isFinalLesson, activeEnrollment, pausedEnrollment, pendingEnrollment, completedEnrollments, buttonState } = ctx;
    const state = buttonState ?? this.resolveButtonStateFromEnrollments(activeEnrollment, pausedEnrollment, pendingEnrollment, completedEnrollments);

    switch (messageType) {
      case 'lesson': {
        // During lesson delivery, show context-appropriate buttons
        if (isFinalLesson) {
          // Last lesson: show Courses to browse more, or Review if supported
          return this.buttons.courses;
        }
        // Mid-course lesson: show Next/Pause (cmds1 for active learners)
        if (state === 'active') {
          return this.buttons.cmds1 ?? this.buttons.next;
        }
        return this.buttons.next;
      }

      case 'completion': {
        // Course just completed: show Browse Courses or Review
        return this.buttons.courses;
      }

      case 'pause_prompt': {
        // After PAUSE command: show Resume
        return this.buttons.resume;
      }

      case 'welcome': {
        // Welcome/opt-in: show Start Course if pending, Resume if paused, else Browse Courses
        if (pendingEnrollment) return this.buttons.startCourse ?? this.buttons.resume ?? this.buttons.courses;
        if (pausedEnrollment) return this.buttons.resume ?? this.buttons.cmds2;
        return this.buttons.courses;
      }

      case 'command_response': {
        // For command responses (COURSES, PROGRESS, etc.), use state-based selection
        switch (state) {
          case 'active':
            return this.buttons.cmds1 ?? this.buttons.courses;
          case 'paused':
            return this.buttons.cmds2 ?? this.buttons.resume;
          case 'pending':
            return this.buttons.resume ?? this.buttons.courses; // Show "Resume/Start" button for pending
          case 'completed':
          case 'new':
            return this.buttons.courses;
        }
        break;
      }

      case 'error':
      default: {
        // Fallback to state-based selection
        switch (state) {
          case 'active':
            return this.buttons.cmds1 ?? this.buttons.courses;
          case 'paused':
            return this.buttons.cmds2 ?? this.buttons.resume;
          case 'pending':
            return this.buttons.resume ?? this.buttons.courses;
          case 'completed':
          case 'new':
            return this.buttons.courses;
        }
        break;
      }
    }
  }

  /** Resolve button state from enrollment objects directly (avoids extra query). */
  private resolveButtonStateFromEnrollments(
    active: EnrollmentSummary | null | undefined,
    paused: EnrollmentSummary | null | undefined,
    pending: EnrollmentSummary | null | undefined,
    completed: EnrollmentSummary[] | undefined
  ): ButtonState {
    if (active) return 'active';
    if (paused) return 'paused';
    if (pending) return 'pending';
    if (completed && completed.length > 0) return 'completed';
    return 'new';
  }

  async handleMessage(input: ChatbotInput): Promise<ChatbotReply> {
    // Opt-out comes first and gates everything. An opted-out learner gets complete silence
    // except the STOP confirmation itself (and START, which opts back in and therefore sends
    // to a subscribed number). Silence — not an "unsubscribed" notice — is the compliant
    // behaviour: every message to an opted-out number needs consent.
    const keyword = parseKeyword(input.text);
    if (keyword?.kind === 'stop') return this.optOut(input.userId);
    if (await this.optOuts.isOptedOut(input.userId)) {
      if (keyword?.kind === 'optin') return this.optIn(input.userId);
      return { text: '', noSend: true };
    }
    if (keyword?.kind === 'optin' && keyword.word !== 'start') {
      return this.offerCourses("You're already subscribed. Send COURSES to see what's available.", 'Tap Courses to see what\'s available.');
    }

    const command = parseCommand(input.text);
    switch (command?.name) {
      case 'courses':
        return this.listCourses(input.userId);
      case 'start':
        return this.start(input.userId, command.arg);
      case 'start_course':
        return this.resume(input.userId); // Start Course button acts like Resume for pending
      case 'next':
        return this.next(input.userId);
      case 'pause':
        return this.pause(input.userId);
      case 'resume':
        return this.resume(input.userId);
      case 'quiz_answer':
        return this.handleQuizAnswer(input.userId, command.arg);
      case 'progress':
        return this.progress(input.userId);
      case 'certificate':
        return this.certificate(input.userId);
      default: {
        const orgId = await this.resolveOrgId(input.userId);
        // A greeting from someone registered on the web but not started: offer Start Course.
        const pendingStart = await this.enrollments.findLatest(orgId, input.userId, 'pending');
        if (pendingStart && isGreeting(input.text)) return this.pendingPrompt(pendingStart);

        // Free text from a learner with a course: answer from THAT course only (or refuse).
        const tutored = await this.askTutor(input);
        if (tutored) return tutored;

        // Not a course command: keep the original behaviour, plus a pointer to the new ones.
        // Buttons follow the learner's state, so a new user is offered Courses while an
        // active learner keeps Next/Pause — never a fixed set for every state.
        const reply = await this.fallback.handleMessage(input);
        const pending = await this.enrollments.findLatest(orgId, input.userId, 'pending');
        return this.withCommandButtons(
          { ...reply, text: `${reply.text}\n\n${COMMAND_HELP}` },
          await this.resolveButtonState(input.userId),
          { messageType: 'command_response', pendingEnrollment: pending ?? undefined },
        );
      }
    }
  }

  // ---- STOP / START (opt-out) -----------------------------------------------------------

  private async optOut(userId: string): Promise<ChatbotReply> {
    if (!(await this.optOuts.optOut(userId))) {
      return stopConfirmation("You're already unsubscribed. Send START to opt back in.");
    }
    // Keep their place but stop every active course (opt-out is global across orgs).
    for (const e of await this.enrollments.locateUser(userId)) {
      if (e.status === 'active') await this.enrollments.pause(e.orgId, e.id);
    }
    this.logger.info('learner.opted_out', {});
    return stopConfirmation(
      "You're unsubscribed. I won't send you any more lessons or reminders.\n\n" +
        'Your progress is saved. Send START any time to opt back in.',
    );
  }

  private async optIn(userId: string): Promise<ChatbotReply> {
    await this.optOuts.optIn(userId);
    this.logger.info('learner.opted_in', {});
    const paused = await this.enrollments.findLatest(await this.resolveOrgId(userId), userId, 'paused');
    if (!paused) {
      return this.withCommandButtons(
        say("Welcome back, you're subscribed again! 👋\n\nSend COURSES to see what's available."),
        await this.resolveButtonState(userId),
        { messageType: 'welcome' },
      );
    }
    return this.offerResume(
      `Welcome back, you're subscribed again! 👋\n\nSend RESUME to continue *${paused.courseTitle}* where you left off.`,
      `Welcome back, you're subscribed again! 👋 Tap Resume to continue *${paused.courseTitle}* where you left off.`,
    );
  }

  // ---- COURSES --------------------------------------------------------------------------

  private async listCourses(userId: string): Promise<ChatbotReply> {
    const state = await this.resolveButtonState(userId);
    const courses = (
      await this.courses.listCourses(await this.resolveOrgId(userId), { status: 'published' })
    ).filter((c) => c.lessonCount > 0);
    if (courses.length === 0) return this.withCommandButtons(say('No courses are available yet. Please check back soon.'), state, { messageType: 'command_response' });

    const shown = courses.slice(0, MAX_COURSES_LISTED);
    const lines = shown.map(
      (c) =>
        `${c.id}. *${c.title}* — ${plural(c.lessonCount, 'lesson')}` +
        (c.description ? `\n   ${truncate(c.description, 90)}` : ''),
    );
    const more =
      courses.length > shown.length ? `\n\n…and ${courses.length - shown.length} more.` : '';

    // Check if we have course selection buttons for these courses
    const courseSelectButtons = this.getCourseSelectButtons(shown);
    if (courseSelectButtons) {
      const text = `📚 *Available courses*\n\n${lines.join('\n\n')}${more}\n\nTap a course to start:`;
      return { text: courseSelectButtons.withButton, contentSid: courseSelectButtons.contentSid, fallbackText: text };
    }

    const list = say(
      `📚 *Available courses*\n\n${lines.join('\n\n')}${more}\n\n` +
        `Reply *START <number>* to begin, e.g. START ${shown[0]?.id ?? 1}.`,
    );
    // Only a learner with an active course gets command buttons here: Next/Pause act on
    // that course. For everyone else the typed START <number> instruction IS the interface —
    // Next/Pause would be dead ends.
    return state === 'active' ? this.withCommandButtons(list, state, { messageType: 'command_response' }) : list;
  }

  /** Get course selection buttons for the given courses (max 3 per template). */
  private getCourseSelectButtons(courses: { id: number; title: string }[]): { contentSid: string; withButton: string } | null {
    if (!this.buttons.courseSelect || this.buttons.courseSelect.length === 0) return null;
    // For now, use the first template (in a real app, you'd paginate)
    const contentSid = this.buttons.courseSelect[0];
    if (!contentSid) return null;
    const titles = courses.slice(0, 3).map(c => `${c.id}. ${c.title}`);
    const withButton = `📚 *Available courses*\n\n${titles.join('\n\n')}\n\nTap a course to start:`;
    return { contentSid, withButton };
  }

  // ---- START <course> -------------------------------------------------------------------

  private async start(userId: string, ref: string): Promise<ChatbotReply> {
    const orgId = await this.resolveOrgId(userId);
    const course = await this.courses.findCourseByRef(orgId, ref);
    const existing = course ? await this.enrollments.find(orgId, userId, course.id) : undefined;

    // Drafts are invisible to learners unless they are already enrolled.
    if (!course || (course.status !== 'published' && !existing)) {
      return say(
        `I couldn't find a course matching "${truncate(ref, 40)}". Send COURSES to see what's available.`,
      );
    }

    if (existing) {
      if (existing.status === 'completed') {
        return this.offerCourses(
          `You've already completed *${course.title}* ✅\n\nSend COURSES to find another course.`,
          'Tap Courses to find another course.',
        );
      }
      if (existing.status === 'paused') return this.resumeEnrollment(userId, existing);
      return this.withCommandButtons(
        say(
          `You're already taking *${course.title}*.\n\n${this.progressLine(existing)}\n${this.nextHint(existing)}`,
        ),
        'active',
        { messageType: 'command_response' },
      );
    }

    const active = await this.enrollments.findActive(orgId, userId);
    if (active) return this.busy(active);

    const lesson = await this.courses.getLessonAt(orgId, course.id, 1);
    if (!lesson) return say('That course has no lessons yet. Please check back soon.');

    const intro =
      `🎓 *${course.title}*` +
      (course.description ? `\n\n${course.description}` : '') +
      `\n\n${plural(course.lessonCount, 'lesson')}. I'll send one at a time — reply NEXT whenever you're ready. ` +
      `You can PAUSE any time and pick up later with RESUME.`;
    const messages: ReplyMessage[] = [
      { text: intro },
      ...renderLesson(
        {
          courseTitle: course.title,
          lessonNumber: 1,
          lessonCount: course.lessonCount,
          lessonTitle: lesson.title,
        },
        lesson.items,
        this.buttons,
      ),
    ];
    const isFinal = course.lessonCount <= 1;
    if (isFinal && this.certificates) messages.push({ text: 'Send *CERTIFICATE* to get your certificate of completion.' });

    return fromMessages(
      messages,
      async () => {
        if (await this.enrollments.begin(orgId, userId, course.id, 1, isFinal)) {
          this.logger.info('course.enrolled', { courseId: course.id });
          if (isFinal) this.logger.info('course.completed', { courseId: course.id });
        }
      },
      { type: 'begin', orgId, userId, courseId: course.id, position: 1, isFinal },
    );
  }

  // ---- NEXT -----------------------------------------------------------------------------

  private async next(userId: string): Promise<ChatbotReply> {
    const orgId = await this.resolveOrgId(userId);
    const active = await this.enrollments.findActive(orgId, userId);
    if (!active) {
      const paused = await this.enrollments.findLatest(orgId, userId, 'paused');
      if (paused) {
        return this.offerResume(
          `⏸️ *${paused.courseTitle}* is paused.\n\nSend RESUME to continue where you left off.`,
          `⏸️ *${paused.courseTitle}* is paused. Tap Resume to continue where you left off.`,
        );
      }
      const done = await this.enrollments.findLatest(orgId, userId, 'completed');
      if (done) {
        return this.offerCourses(
          `You've completed *${done.courseTitle}* 🎉\n\nSend COURSES to start another one.`,
          'Tap Courses to find another course.',
        );
      }
      return this.offerCourses(
        "You haven't started a course yet. Send COURSES to see what's available.",
        'Tap Courses to see what\'s available.',
      );
    }

    // Quiz gate: the learner must answer the current lesson's quiz before moving on.
    if (active.lastDeliveredPosition >= 1) {
      const current = await this.courses.getLessonAt(
        orgId,
        active.courseId,
        active.lastDeliveredPosition,
      );
      const pendingQuiz = current?.items.find(
        (i): i is Extract<LessonItem, { kind: 'quiz' }> => i.kind === 'quiz',
      );
      if (
        pendingQuiz &&
        !(await this.enrollments.hasQuizAnswer(orgId, active.id, active.lastDeliveredPosition))
      ) {
        const letters = pendingQuiz.options.map((_, i) => String.fromCharCode(65 + i));
        const prompt =
          `Please answer the quiz in *Lesson ${active.lastDeliveredPosition}* first — ` +
          `reply ${letters.join(', ')}.`;
        const quizSid = this.buttons.quiz;
        return quizSid
          ? { text: `${prompt} Tap a button to answer:`, contentSid: quizSid, fallbackText: prompt }
          : say(prompt);
      }
    }

    const position = active.lastDeliveredPosition + 1;
    if (position > active.lessonCount) {
      // Everything was already delivered (only reachable if completion was never recorded).
      await this.enrollments.complete(orgId, active.id);
      return this.offerCourses(
        `You've finished *${active.courseTitle}* 🎉\n\nSend COURSES to start another one.`,
        'Tap Courses to find another course.',
      );
    }

    const lesson = await this.courses.getLessonAt(orgId, active.courseId, position);
    if (!lesson) {
      this.logger.error('course.lesson.missing', { courseId: active.courseId, position });
      return say(
        "Sorry, I couldn't load that lesson right now. Please try NEXT again in a moment.",
      );
    }

    const messages = renderLesson(
      {
        courseTitle: active.courseTitle,
        lessonNumber: position,
        lessonCount: active.lessonCount,
        lessonTitle: lesson.title,
      },
      lesson.items,
      this.buttons,
    );
    const isFinal = position === active.lessonCount;
    // The certificate rides with the final lesson. Its link is signed from the enrollment id, so
    // it exists before the record does; the record itself is written once, after delivery.
    // Lock, update and commit inside advance/issue; the send already happened in the controller.
    if (isFinal) messages.push(...(await this.certificateMessages(active)));

    return fromMessages(
      messages,
      async () => {
        const advanced = await this.enrollments.advance(orgId, active.id, position - 1, position, isFinal);
        if (!advanced) {
          this.logger.warn('course.progress.not_advanced', { enrollmentId: active.id, position });
          return;
        }
        this.logger.info('course.lesson.delivered', { enrollmentId: active.id, position });
        if (isFinal) {
          this.logger.info('course.completed', { enrollmentId: active.id });
          await this.certificates?.issue(orgId, active.id);
        }
      },
      {
        type: 'advance',
        orgId,
        enrollmentId: active.id,
        from: position - 1,
        to: position,
        isFinal,
        issueCertificate: isFinal,
      },
    );
  }

  // ---- PAUSE / RESUME -------------------------------------------------------------------

  private async pause(userId: string): Promise<ChatbotReply> {
    const orgId = await this.resolveOrgId(userId);
    const active = await this.enrollments.findActive(orgId, userId);
    if (!active) {
      const paused = await this.enrollments.findLatest(orgId, userId, 'paused');
      return paused
        ? this.offerResume(
            `*${paused.courseTitle}* is already paused. Send RESUME to continue.`,
            `*${paused.courseTitle}* is already paused. Tap Resume to continue.`,
          )
        : this.offerCourses(
            "You don't have a course in progress. Send COURSES to see what's available.",
            'Tap Courses to see what\'s available.',
          );
    }
    await this.enrollments.pause(orgId, active.id);
    return this.offerResume(
      `⏸️ Paused *${active.courseTitle}* — ${this.progressLine(active)}\n\nSend RESUME whenever you want to continue.`,
      `⏸️ Paused *${active.courseTitle}* — ${this.progressLine(active)} Tap Resume whenever you want to continue.`,
    );
  }

  /** A reply that offers a Resume button when that template is configured, else typed text. */
  private offerResume(plain: string, withButton: string): ChatbotReply {
    const contentSid = this.buttons.resume;
    return contentSid ? { text: withButton, contentSid, fallbackText: plain } : say(plain);
  }

  /**
   * A helpful plain-text reply plus a Courses tap-button when that template is configured,
   * else just the plain text. Mirrors renderLesson's pattern (content first, button prompt
   * second with a typed-command fallback), so "Tap Courses" is always actionable.
   */
  private offerCourses(plain: string, buttonPrompt: string): ChatbotReply {
    const contentSid = this.buttons.courses;
    if (!contentSid) return say(plain);
    return {
      text: plain,
      followUps: [
        {
          text: buttonPrompt,
          contentSid,
          fallbackText: 'Send COURSES to find another course.',
        },
      ],
    };
  }

  private async resume(userId: string): Promise<ChatbotReply> {
    const orgId = await this.resolveOrgId(userId);
    const active = await this.enrollments.findActive(orgId, userId);
    if (active) {
      return this.withCommandButtons(
        say(
          `You're already on *${active.courseTitle}*.\n\n${this.progressLine(active)}\n${this.nextHint(active)}`,
        ),
        'active',
        { messageType: 'command_response' },
      );
    }
    // Check for pending enrollment first (pre-enrolled via dashboard)
    const pending = await this.enrollments.findLatest(orgId, userId, 'pending');
    if (pending) {
      return this.startPendingEnrollment(userId, pending);
    }
    const paused = await this.enrollments.findLatest(orgId, userId, 'paused');
    if (!paused)
      return this.offerCourses(
        'There is nothing to resume. Send COURSES to start a course.',
        'Tap Courses to see what\'s available.',
      );
    return this.resumeEnrollment(userId, paused);
  }

  private async startPendingEnrollment(
    userId: string,
    enrollment: EnrollmentSummary,
  ): Promise<ChatbotReply> {
    const active = await this.enrollments.findActive(enrollment.orgId, userId);
    if (active) return this.busy(active);
    const started = await this.enrollments.startPending(enrollment.orgId, enrollment.id);
    if (!started) {
      return say("Sorry, I couldn't start that course right now. Please try again.");
    }
    // Now deliver the first lesson, introduced by a short course welcome.
    const lesson = await this.next(userId);
    const course = await this.courses.getCourse(enrollment.orgId, enrollment.courseId);
    const intro: ReplyMessage = {
      text:
        `🎓 *${enrollment.courseTitle}*` +
        (course?.description ? `\n\n${course.description}` : '') +
        `\n\n${plural(enrollment.lessonCount, 'lesson')}. Use *Next* for each lesson, *Pause* to take a break and *Resume* to carry on. ` +
        `You can also type a question about the course any time.`,
    };
    const first: ReplyMessage = {
      text: lesson.text,
      ...(lesson.mediaUrl && { mediaUrl: lesson.mediaUrl }),
      ...(lesson.contentSid && { contentSid: lesson.contentSid }),
      ...(lesson.fallbackText && { fallbackText: lesson.fallbackText }),
    };
    return fromMessages(
      [intro, first, ...(lesson.followUps ?? [])],
      lesson.onDelivered,
      lesson.deliveryAction,
    );
  }

  private pendingPrompt(pending: EnrollmentSummary): ChatbotReply {
    const plain = `Welcome back! 👋 You're registered for *${pending.courseTitle}* but haven't started yet.\n\nReply *START COURSE* to begin lesson 1.`;
    const contentSid = this.buttons.startCourse;
    return contentSid
      ? {
          text: `Welcome back! 👋 You're registered for *${pending.courseTitle}*. Tap Start Course to begin lesson 1.`,
          contentSid,
          fallbackText: plain,
        }
      : say(plain);
  }

  // ---- Course Q&A -----------------------------------------------------------------------

  private async askTutor(input: ChatbotInput): Promise<ChatbotReply | null> {
    const text = input.text.trim();
    if (!this.tutor || text.length < 3 || ['help'].includes(text.toLowerCase()) || isGreeting(text)) return null;
    const orgId = await this.resolveOrgId(input.userId);
    const enrollment =
      (await this.enrollments.findActive(orgId, input.userId)) ??
      (await this.enrollments.findLatest(orgId, input.userId, 'paused'));
    if (!enrollment) return null;

    const result = await this.tutor.answer(enrollment, text);
    const active = enrollment.status === 'active';
    const sid = active ? this.buttons.next : this.buttons.resume;
    const hint = active
      ? 'Send NEXT to continue, or PAUSE to take a break.'
      : 'Send RESUME to continue where you left off.';
    return sid
      ? { text: result.text, followUps: [{ text: 'Ready to continue?', contentSid: sid, fallbackText: hint }] }
      : say(`${result.text}\n\n${hint}`);
  }

  // ---- Certificates ---------------------------------------------------------------------

  /** The WhatsApp messages that deliver a certificate for a (completed or completing) enrollment. */
  private async certificateMessages(enrollment: EnrollmentSummary): Promise<ReplyMessage[]> {
    if (!this.certificates) return [];
    return certificateMessagesFor(
      {
        certificates: this.certificates,
        publicBaseUrl: this.publicBaseUrl,
        learnerName: this.learnerName,
      },
      enrollment,
    );
  }

  private async certificate(userId: string): Promise<ChatbotReply> {
    const orgId = await this.resolveOrgId(userId);
    const done = await this.enrollments.findLatest(orgId, userId, 'completed');
    if (!done || !this.certificates) {
      return this.offerCourses(
        "You haven't completed a course yet — finish one and your certificate arrives automatically. Send COURSES to browse.",
        "Tap Courses to browse what's available.",
      );
    }
    await this.certificates.issue(orgId, done.id);
    return fromMessages(await this.certificateMessages(done));
  }

  private async resumeEnrollment(
    userId: string,
    enrollment: EnrollmentSummary,
  ): Promise<ChatbotReply> {
    const active = await this.enrollments.findActive(enrollment.orgId, userId);
    if (active) return this.busy(active);
    if (!(await this.enrollments.resume(enrollment.orgId, enrollment.id))) {
      return say("Sorry, I couldn't resume that course right now. Please try again.");
    }
    return this.withCommandButtons(
      say(
        `▶️ Welcome back to *${enrollment.courseTitle}*!\n\n${this.progressLine(enrollment)}\n${this.nextHint(enrollment)}`,
      ),
      'active',
      { messageType: 'command_response' },
    );
  }

  private async handleQuizAnswer(userId: string, answer: string): Promise<ChatbotReply> {
    // The quiz belongs to the lesson most recently delivered, which may be a course's last lesson.
    const orgId = await this.resolveOrgId(userId);
    const enrollment =
      (await this.enrollments.findActive(orgId, userId)) ??
      (await this.enrollments.findLatest(orgId, userId, 'completed')) ??
      (await this.enrollments.findLatest(orgId, userId, 'paused'));
    if (!enrollment || enrollment.lastDeliveredPosition < 1) {
      return say("You don't have a quiz waiting. Send COURSES to start a course.");
    }
    const lesson = await this.courses.getLessonAt(
      orgId,
      enrollment.courseId,
      enrollment.lastDeliveredPosition,
    );
    const quiz = lesson?.items.find((i): i is Extract<LessonItem, { kind: 'quiz' }> => i.kind === 'quiz');
    if (!quiz || quiz.options.length === 0) {
      return say('There is no quiz in your current lesson. Send NEXT to continue.');
    }

    const letters = quiz.options.map((_, i) => String.fromCharCode(65 + i));
    const chosen = letters.indexOf(answer.trim().toUpperCase());
    if (chosen === -1) {
      return say(`Please answer with one of: ${letters.join(', ')}.`);
    }
    const correct = quiz.options.findIndex((o) => o.correct === true);
    await this.enrollments.recordQuizAnswer(
      orgId,
      enrollment.id,
      enrollment.lastDeliveredPosition,
      chosen,
      correct !== -1 && chosen === correct,
    );
    const next =
      enrollment.status === 'completed'
        ? 'Send *CERTIFICATE* to get your certificate.'
        : enrollment.status === 'paused'
          ? 'Send *RESUME* to continue.'
          : 'Send *NEXT* for the next lesson.';

    if (correct === -1) {
      // Authored without a marked answer: never pretend to grade it.
      return say(`Thanks, got your answer *${letters[chosen]}*.\n\n${next}`);
    }
    const right = `*${letters[correct]}) ${quiz.options[correct]?.label ?? ''}*`;
    const explanation = quiz.explanation?.trim();
    const feedbackSuffix = explanation ? `\n\n${explanation}` : '';
    return say(
      chosen === correct
        ? `✅ Correct! The answer is ${right}.${feedbackSuffix}\n\n${next}`
        : `❌ Not quite. The correct answer is ${right}.\n\nNo worries, keep going!${feedbackSuffix}\n\n${next}`,
    );
  }

  // ---- PROGRESS -------------------------------------------------------------------------

  private async progress(userId: string): Promise<ChatbotReply> {
    const all = await this.enrollments.listForUser(await this.resolveOrgId(userId), userId);
    const state = buttonStateForStatuses(all.map((e) => e.status));
    if (all.length === 0) {
      return this.withCommandButtons(say("You haven't started a course yet. Send COURSES to see what's available."), state, { messageType: 'command_response' });
    }
    const icon: Record<EnrollmentStatus, string> = { active: '▶️', paused: '⏸️', pending: '⏳', completed: '✅' };
    const lines = all.map(
      (e) =>
        `${icon[e.status]} *${e.courseTitle}* — ${e.lastDeliveredPosition} of ${plural(e.lessonCount, 'lesson')}` +
        (e.status === 'completed' ? ' (completed)' : e.status === 'paused' ? ' (paused)' : ''),
    );
    const active = all.find((e) => e.status === 'active');
    const paused = all.find((e) => e.status === 'paused');
    const hint = active
      ? this.nextHint(active)
      : paused
        ? 'Send RESUME to continue.'
        : 'Send COURSES to start another course.';
    return this.withCommandButtons(say(`📊 *Your progress*\n\n${lines.join('\n')}\n\n${hint}`), state, { messageType: 'command_response' });
  }

  // ---- shared wording -------------------------------------------------------------------

  private progressLine(e: EnrollmentSummary): string {
    return `${e.lastDeliveredPosition} of ${plural(e.lessonCount, 'lesson')} done.`;
  }

  private nextHint(e: EnrollmentSummary): string {
    return `Send *NEXT* for lesson ${e.lastDeliveredPosition + 1}.`;
  }

  private busy(active: EnrollmentSummary): ChatbotReply {
    return this.withCommandButtons(
      say(
        `You're currently taking *${active.courseTitle}* (${this.progressLine(active)}).\n\n` +
          'Send PAUSE to set it aside, then START the other course. (Your progress is saved.)',
      ),
      'active',
      { messageType: 'command_response' },
    );
  }

  /**
   * Wrap a reply with the context-appropriate command buttons.
   *
   * The reply's own text is kept as the button message body (it becomes the template's
   * {{1}} variable), so the learner always sees the real content — course list, progress,
   * help — with tap-buttons attached. If the button send fails, the same text goes out as
   * plain typed-commands fallback. Never replace the body with a generic prompt: that hides
   * the content the learner asked for.
   *
   * A reply that already carries a button template (e.g. the fallback Chatbot's main-menu
   * buttons) keeps it when the selector has nothing better configured.
   */
  private withCommandButtons(reply: ChatbotReply, state: ButtonState, context?: Partial<ButtonContext>): ChatbotReply {
    const ctx: ButtonContext = { messageType: 'command_response', buttonState: state, ...context };
    const contentSid = this.selectButtonSidForContext(ctx);
    if (!contentSid) return reply;
    return { ...reply, contentSid, fallbackText: reply.fallbackText ?? reply.text };
  }

  /** Legacy selector for backward compatibility. */
  private selectButtonSid(state: ButtonState): string | undefined {
    switch (state) {
      case 'active':
        return this.buttons.cmds1 ?? this.buttons.courses;
      case 'paused':
        return this.buttons.cmds2 ?? this.buttons.resume;
      case 'completed':
      case 'new':
        return this.buttons.courses;
    }
  }
}
