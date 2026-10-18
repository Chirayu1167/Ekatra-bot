import express, { Router } from 'express';
import { NotFoundError } from '../errors';
import type { Logger } from '../logger';
import { silentLogger } from '../logger';
import type { CourseService } from '../services/course.service';
import type { EnrollmentService } from '../services/enrollment.service';
import type { LearnerService } from '../services/learner.service';
import type { OptOutService } from '../services/optout.service';
import type { OrganisationsService } from '../services/organisations.service';

export interface RegistrationRouterOptions {
  courses: CourseService;
  enrollments: EnrollmentService;
  learners: LearnerService;
  optOuts: OptOutService;
  orgs: OrganisationsService;
  logger?: Logger;
  now?: () => number;
}

const PHONE_REGEX = /^whatsapp:\+\d{7,15}$/;

/** Validate and normalize a WhatsApp number. Returns null if it can't be one. */
export function normalizeWhatsAppNumber(input: string): string | null {
  const cleaned = input.trim().replace(/[\s()-]/g, '');
  if (PHONE_REGEX.test(cleaned)) return cleaned;
  // Require an explicit country code: bare national numbers (e.g. 10-digit
  // Indian numbers without +91) would otherwise map to the wrong WhatsApp ID
  // and the bot could never match the registration on "HI".
  if (/^\+\d{7,15}$/.test(cleaned)) return `whatsapp:${cleaned}`;
  return null;
}

/** Small in-memory sliding window. Enough to stop a form being used to spam one number. */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

const HOUR = 3_600_000;

export function createRegistrationRouter(opts: RegistrationRouterOptions): Router {
  const { courses, enrollments, learners, optOuts, orgs } = opts;
  const logger = opts.logger ?? silentLogger;
  const now = opts.now ?? Date.now;
  const router = Router();
  const perIp = new RateLimiter(20, HOUR, now);
  const perPhone = new RateLimiter(3, HOUR, now);

  /**
   * Org scope for public registration: `?org=<slug>` selects the org, plain requests use
   * the default org. Slugs resolve server-side; unknown slugs are 404 (never trusted blindly).
   */
  const resolveOrg = async (raw: unknown): Promise<number> => {
    if (raw === undefined) return orgs.getDefaultId();
    if (typeof raw !== 'string') throw new NotFoundError('Organisation not found');
    const org = await orgs.getBySlug(raw.trim().toLowerCase());
    if (!org) throw new NotFoundError('Organisation not found');
    return org.id;
  };

  router.get('/', (_req, res) => {
    res.type('html').send(getRegistrationPage());
  });

  router.get('/courses', async (req, res) => {
    try {
      const orgId = await resolveOrg(req.query['org']);
      const available = (
        await courses.listCourses(orgId, { status: 'published' })
      ).filter((c) => c.lessonCount > 0)
        .map((c) => ({
          id: c.id,
          title: c.title,
          description: c.description,
          lessonCount: c.lessonCount,
        }));
      res.json({ courses: available });
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: 'Organisation not found' });
        return;
      }
      res.status(500).json({ error: 'Failed to fetch courses' });
    }
  });

  router.post('/', express.json({ limit: '8kb' }), async (req, res) => {
    try {
      if (!perIp.allow(req.ip ?? 'unknown')) {
        return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      }
      const orgId = await resolveOrg(
        (req.body as { org?: unknown } | null)?.org ?? req.query['org'],
      );
      const body = (req.body ?? {}) as {
        name?: unknown;
        phoneNumber?: unknown;
        courseId?: unknown;
        consent?: unknown;
      };
      const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
      const phone =
        typeof body.phoneNumber === 'string' ? normalizeWhatsAppNumber(body.phoneNumber) : null;
      const courseId = Number(body.courseId);

      if (name.length < 1 || name.length > 60) {
        return res.status(400).json({ error: 'Please enter your name (up to 60 characters).' });
      }
      if (!phone) {
        return res.status(400).json({
          error: 'Enter a valid WhatsApp number with country code, e.g. +91 98765 43210.',
        });
      }
      if (!Number.isInteger(courseId) || courseId < 1) {
        return res.status(400).json({ error: 'Please choose a course.' });
      }
      if (body.consent !== true) {
        return res
          .status(400)
          .json({ error: 'Please agree to receive course messages on WhatsApp.' });
      }

      const course = await courses.getCourse(orgId, courseId);
      if (!course || course.status !== 'published' || course.lessonCount < 1) {
        return res.status(404).json({ error: 'Course not found or not published' });
      }
      if (await optOuts.isOptedOut(phone)) {
        return res.status(409).json({
          error:
            'This number has unsubscribed. Send START to our WhatsApp number to opt back in, then register again.',
        });
      }

      const existing = await enrollments.find(orgId, phone, courseId);
      if (existing && existing.status !== 'pending') {
        const msg =
          existing.status === 'completed'
            ? `You've already completed "${course.title}".`
            : `You're already taking "${course.title}". Open WhatsApp and send NEXT or RESUME.`;
        return res.status(409).json({ error: msg });
      }
      const active = await enrollments.findActive(orgId, phone);
      if (active) {
        return res.status(409).json({
          error: `You already have an active course ("${active.courseTitle}"). Pause or finish it first.`,
          activeCourse: active.courseTitle,
        });
      }

      // A resend for an already-pending registration is allowed, but throttled per number.
      if (!perPhone.allow(phone)) {
        return res
          .status(429)
          .json({ error: 'We already messaged this number recently. Please check WhatsApp.' });
      }

      await learners.upsert(phone, name);
      const enrollment = await enrollments.createPending(orgId, phone, courseId);
      logger.info('registration.created', { courseId });

      return res.json({
        success: true,
        message: `You're registered for "${course.title}". Send "HI" on WhatsApp to see your course and start learning.`,
        enrollment: {
          id: enrollment.id,
          courseId: enrollment.courseId,
          courseTitle: enrollment.courseTitle,
          status: enrollment.status,
        },
      });
    } catch (err) {
      if (err instanceof NotFoundError && err.message === 'Organisation not found') {
        return res.status(404).json({ error: 'Organisation not found' });
      }
      logger.error('registration.failed', { error: String(err) });
      return res.status(500).json({ error: 'Registration failed' });
    }
  });

  return router;
}

function getRegistrationPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ekatra – Learn on WhatsApp | Course Enrolment</title>
  <meta name="description" content="Enrol in free bite-sized courses delivered on WhatsApp and earn a certificate.">
  <style>
    :root {
      --blue: #0056D2; --blue-dark: #00419E; --blue-soft: #F0F6FF; --blue-line: #CFE0FB;
      --ink: #0F1114; --ink-2: #404852; --ink-3: #6A7380; --line: #DAE1E8; --bg: #FFFFFF;
      --green: #1F8354; --green-soft: #E7F6EE; --red: #C3342B; --red-soft: #FDECEA; --wa: #25D366;
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body { font-family: 'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: var(--bg); line-height: 1.5; -webkit-font-smoothing: antialiased; }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    :focus-visible { outline: 3px solid #7FB0FF; outline-offset: 2px; }

    /* ---------- top nav ---------- */
    .nav { position: sticky; top: 0; z-index: 20; background: #fff; border-bottom: 1px solid var(--line); }
    .nav-inner { max-width: 1200px; margin: 0 auto; padding: 0 24px; height: 64px; display: flex; align-items: center; gap: 28px; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 22px; color: var(--blue); letter-spacing: -0.5px; }
    .brand:hover { text-decoration: none; }
    .brand-mark { width: 32px; height: 32px; border-radius: 8px; background: var(--blue); color: #fff; display: grid; place-items: center; font-size: 18px; font-weight: 800; }
    .nav-links { display: flex; gap: 22px; font-size: 15px; font-weight: 600; margin-left: 8px; }
    .nav-links a { color: var(--ink-2); padding: 20px 0; border-bottom: 3px solid transparent; }
    .nav-links a:hover, .nav-links a.active { color: var(--blue); border-bottom-color: var(--blue); text-decoration: none; }
    .nav-spacer { flex: 1; }
    .nav-pill { font-size: 13px; font-weight: 600; color: var(--green); background: var(--green-soft); padding: 6px 12px; border-radius: 999px; display: flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }

    /* ---------- hero ---------- */
    .hero { background: linear-gradient(180deg, var(--blue-soft) 0%, #fff 100%); border-bottom: 1px solid var(--line); }
    .hero-inner { max-width: 1200px; margin: 0 auto; padding: 20px 24px 36px; }
    .crumbs { font-size: 13px; color: var(--ink-3); margin-bottom: 20px; display: flex; gap: 8px; flex-wrap: wrap; }
    .crumbs span.sep { color: #AAB3BD; }
    .crumbs b { color: var(--ink); font-weight: 600; }
    .hero h1 { font-size: 40px; line-height: 1.15; letter-spacing: -0.8px; max-width: 700px; font-weight: 800; }
    .hero p.lead { margin-top: 12px; font-size: 18px; color: var(--ink-2); max-width: 640px; }
    .badges { display: flex; gap: 10px 22px; flex-wrap: wrap; margin-top: 22px; }
    .badge { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--ink-2); }
    .badge svg { color: var(--blue); flex: none; }

    /* ---------- layout ---------- */
    .layout { max-width: 1200px; margin: 0 auto; padding: 32px 24px 64px; display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 40px; align-items: start; }
    h2 { font-size: 24px; letter-spacing: -0.3px; font-weight: 800; }
    .section { margin-bottom: 44px; }
    .section-sub { color: var(--ink-3); font-size: 15px; margin-top: 4px; margin-bottom: 18px; }

    /* ---------- course cards ---------- */
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .card { position: relative; text-align: left; font: inherit; color: inherit; background: #fff; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; cursor: pointer; display: flex; flex-direction: column; transition: box-shadow .15s, border-color .15s, transform .15s; }
    .card:hover { box-shadow: 0 6px 20px rgba(15, 17, 20, .10); transform: translateY(-2px); }
    .card.selected { border-color: var(--blue); box-shadow: 0 0 0 2px var(--blue); }
    .thumb { width: 100%; flex: none; height: 112px; display: flex; align-items: flex-end; padding: 14px 16px; color: #fff; position: relative; overflow: hidden; }
    .thumb::after { content: ''; position: absolute; right: -30px; top: -30px; width: 130px; height: 130px; border-radius: 50%; background: rgba(255, 255, 255, .14); }
    .thumb::before { content: ''; position: absolute; right: 36px; bottom: -50px; width: 100px; height: 100px; border-radius: 50%; background: rgba(255, 255, 255, .10); }
    .thumb-label { font-size: 12px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; background: rgba(0, 0, 0, .22); padding: 3px 8px; border-radius: 4px; position: relative; z-index: 1; }
    .card-body { width: 100%; padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
    .card-org { font-size: 12.5px; color: var(--ink-3); font-weight: 600; }
    .card-title { font-size: 17px; font-weight: 700; line-height: 1.3; }
    .card-desc { font-size: 14px; color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .card-meta { margin-top: auto; padding-top: 8px; font-size: 13px; color: var(--ink-3); display: flex; gap: 14px; align-items: center; }
    .card-meta span { display: inline-flex; gap: 5px; align-items: center; }
    .tick { position: absolute; top: 10px; right: 10px; width: 26px; height: 26px; border-radius: 50%; background: #fff; color: var(--blue); display: none; place-items: center; z-index: 2; box-shadow: 0 1px 4px rgba(0, 0, 0, .25); }
    .card.selected .tick { display: grid; }
    .skeleton { height: 250px; border-radius: var(--radius); background: linear-gradient(90deg, #EEF2F6 25%, #F6F8FA 37%, #EEF2F6 63%); background-size: 400% 100%; animation: shimmer 1.4s infinite; }
    @keyframes shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
    .empty { grid-column: 1 / -1; border: 1px dashed var(--line); border-radius: var(--radius); padding: 32px; text-align: center; color: var(--ink-3); }

    /* ---------- how it works ---------- */
    .steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; counter-reset: s; }
    .step { background: var(--blue-soft); border-radius: var(--radius); padding: 18px 16px; }
    .step-n { width: 30px; height: 30px; border-radius: 50%; background: var(--blue); color: #fff; font-weight: 700; display: grid; place-items: center; font-size: 14px; margin-bottom: 10px; }
    .step h3 { font-size: 15.5px; margin-bottom: 4px; }
    .step p { font-size: 13.5px; color: var(--ink-2); }

    /* ---------- learn list ---------- */
    .learn { border: 1px solid var(--line); border-radius: var(--radius); padding: 22px 24px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 28px; }
    .learn li { list-style: none; display: flex; gap: 10px; font-size: 15px; color: var(--ink-2); }
    .learn svg { color: var(--green); flex: none; margin-top: 3px; }

    /* ---------- enrol panel ---------- */
    .panel { position: sticky; top: 84px; background: #fff; border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 8px 28px rgba(15, 17, 20, .10); overflow: hidden; }
    .panel-top { padding: 22px 24px 4px; }
    .panel-top h2 { font-size: 22px; }
    .panel-top p { font-size: 14px; color: var(--ink-3); margin-top: 2px; }
    .selected-course { margin: 16px 24px 0; padding: 12px 14px; border: 1px solid var(--blue-line); background: var(--blue-soft); border-radius: 10px; display: none; gap: 12px; align-items: center; }
    .selected-course.show { display: flex; }
    .sc-thumb { width: 44px; height: 44px; border-radius: 8px; flex: none; }
    .sc-title { font-weight: 700; font-size: 15px; line-height: 1.25; }
    .sc-meta { font-size: 12.5px; color: var(--ink-3); }
    .form { padding: 18px 24px 24px; }
    .field { margin-bottom: 16px; }
    .field label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
    .field .help { font-size: 12.5px; color: var(--ink-3); margin-top: 5px; }
    .input-wrap { position: relative; }
    .input-wrap svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--ink-3); pointer-events: none; }
    input[type=text], input[type=tel] { width: 100%; height: 46px; padding: 0 14px 0 40px; border: 1px solid #B6C0CB; border-radius: 8px; font: inherit; font-size: 16px; color: var(--ink); background: #fff; }
    input[type=text]:hover, input[type=tel]:hover { border-color: #7C8896; }
    input[type=text]:focus, input[type=tel]:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(0, 86, 210, .18); }
    input:disabled { background: #F3F5F7; color: var(--ink-3); }
    .field label.consent { display: flex; gap: 10px; align-items: flex-start; font-size: 13.5px; color: var(--ink-2); cursor: pointer; font-weight: 400 !important; }
    .consent input { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--blue); flex: none; }
    .btn { width: 100%; height: 50px; border: 0; border-radius: 8px; background: var(--blue); color: #fff; font: inherit; font-size: 16px; font-weight: 700; cursor: pointer; transition: background .15s; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .btn:hover:not(:disabled) { background: var(--blue-dark); }
    .btn:disabled { background: #C8D0D9; cursor: not-allowed; }
    .spinner { width: 16px; height: 16px; border: 2px solid rgba(255, 255, 255, .5); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; display: none; }
    .loading .spinner { display: block; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .alert { display: none; margin-top: 14px; padding: 12px 14px; border-radius: 8px; font-size: 14px; background: var(--red-soft); color: #7A1D17; border: 1px solid #F3C4C0; }
    .alert.show { display: block; }
    .fine { margin-top: 14px; font-size: 12.5px; color: var(--ink-3); text-align: center; }

    /* ---------- success ---------- */
    .success { display: none; padding: 28px 24px 26px; text-align: center; }
    .success.show { display: block; }
    .check { width: 64px; height: 64px; border-radius: 50%; background: var(--green-soft); color: var(--green); display: grid; place-items: center; margin: 0 auto 14px; }
    .success h2 { font-size: 22px; }
    .success .msg { margin-top: 8px; font-size: 15px; color: var(--ink-2); }
    .next { margin-top: 20px; text-align: left; background: var(--blue-soft); border-radius: 10px; padding: 14px 16px; font-size: 14px; color: var(--ink-2); }
    .next b { color: var(--ink); }
    .next ol { margin: 8px 0 0 20px; display: grid; gap: 4px; }
    .kbd { display: inline-block; background: #fff; border: 1px solid var(--blue-line); border-radius: 5px; padding: 0 6px; font-weight: 700; color: var(--blue); font-size: 13px; }
    .link-btn { margin-top: 16px; background: none; border: 0; color: var(--blue); font: inherit; font-weight: 600; cursor: pointer; }
    .link-btn:hover { text-decoration: underline; }

    footer { border-top: 1px solid var(--line); background: #F7F9FB; }
    .foot-inner { max-width: 1200px; margin: 0 auto; padding: 24px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; font-size: 13.5px; color: var(--ink-3); }

    /* ---------- responsive ---------- */
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .panel { position: static; }
      .steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      .nav-links, .nav-pill { display: none; }
      .hero h1 { font-size: 30px; }
      .hero p.lead { font-size: 16px; }
      .grid, .learn { grid-template-columns: 1fr; }
      .layout { padding: 24px 16px 48px; gap: 28px; }
      .hero-inner { padding: 16px 16px 28px; }
      .nav-inner { padding: 0 16px; }
    }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  </style>
</head>
<body>
  <header class="nav">
    <div class="nav-inner">
      <a class="brand" href="/register"><span class="brand-mark">E</span>Ekatra</a>
      <nav class="nav-links" aria-label="Primary">
        <a href="#courses" class="active">Courses</a>
        <a href="#how">How it works</a>
        <a href="#learn">What you get</a>
      </nav>
      <div class="nav-spacer"></div>
      <div class="nav-pill"><span class="dot"></span>Free on WhatsApp</div>
    </div>
  </header>

  <section class="hero">
    <div class="hero-inner">
      <div class="crumbs"><a href="/register">Home</a><span class="sep">/</span><span>Courses</span><span class="sep">/</span><b>Enrolment</b></div>
      <h1>Learn something new, one short lesson at a time.</h1>
      <p class="lead">Enrol in a course and learn right inside WhatsApp. No app to install, no logins &mdash; just bite-sized lessons at your pace, and a certificate when you finish.</p>
      <div class="badges">
        <div class="badge"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>Self-paced</div>
        <div class="badge"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>Mobile-first</div>
        <div class="badge"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"/><path d="M15.5 13 17 22l-5-3-5 3 1.5-9"/></svg>Certificate on completion</div>
      </div>
    </div>
  </section>

  <main class="layout">
    <div>
      <section class="section" id="courses">
        <h2>Choose your course</h2>
        <p class="section-sub">Select a course to enrol. You can learn one course at a time.</p>
        <div class="grid" id="courseGrid" role="radiogroup" aria-label="Available courses">
          <div class="skeleton"></div><div class="skeleton"></div>
        </div>
      </section>

      <section class="section" id="how">
        <h2>How it works</h2>
        <p class="section-sub">From sign-up to certificate in four simple steps.</p>
        <div class="steps">
          <div class="step"><div class="step-n">1</div><h3>Enrol here</h3><p>Pick a course and enter your name and WhatsApp number.</p></div>
          <div class="step"><div class="step-n">2</div><h3>Say &ldquo;HI&rdquo;</h3><p>Send HI to our WhatsApp number to see your course.</p></div>
          <div class="step"><div class="step-n">3</div><h3>Learn daily</h3><p>Tap Next for each lesson. Pause and resume any time.</p></div>
          <div class="step"><div class="step-n">4</div><h3>Get certified</h3><p>Finish the course and receive your certificate.</p></div>
        </div>
      </section>

      <section class="section" id="learn">
        <h2>What you get</h2>
        <p class="section-sub">Everything is included with your enrolment.</p>
        <ul class="learn">
          <li><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Short lessons that fit into your day</li>
          <li><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Learn in the app you already use</li>
          <li><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Pause and resume whenever you like</li>
          <li><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Certificate with your name on completion</li>
        </ul>
      </section>
    </div>

    <aside class="panel" id="enrol" aria-label="Enrolment form">
      <div id="formView">
        <div class="panel-top">
          <h2>Enrol for free</h2>
          <p>Takes less than a minute.</p>
        </div>
        <div class="selected-course" id="selectedCourse">
          <div class="sc-thumb" id="scThumb"></div>
          <div><div class="sc-title" id="scTitle"></div><div class="sc-meta" id="scMeta"></div></div>
        </div>
        <div class="form">
          <div class="field">
            <label for="name">Full name</label>
            <div class="input-wrap">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              <input type="text" id="name" maxlength="60" autocomplete="name" placeholder="e.g., Asha Verma" />
            </div>
            <div class="help">This name is printed on your certificate.</div>
          </div>
          <div class="field">
            <label for="phoneNumber">WhatsApp number</label>
            <div class="input-wrap">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>
              <input type="tel" id="phoneNumber" placeholder="+91 98765 43210" autocomplete="tel" />
            </div>
            <div class="help">Include your country code, e.g. +91 for India.</div>
          </div>
          <div class="field">
            <label class="consent"><input type="checkbox" id="consent" />
              <span>I agree to receive this course as WhatsApp messages. I can reply STOP at any time to unsubscribe.</span></label>
          </div>
          <button class="btn" id="registerBtn" disabled><span class="spinner" aria-hidden="true"></span><span id="btnLabel">Enrol now</span></button>
          <div class="alert" id="errorMsg" role="alert"></div>
          <p class="fine">Free &middot; No app to install &middot; Cancel any time</p>
        </div>
      </div>

      <div class="success" id="successView" aria-live="polite">
        <div class="check"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
        <h2>You&rsquo;re enrolled!</h2>
        <p class="msg" id="successMsg"></p>
        <div class="next">
          <b>What happens next</b>
          <ol>
            <li>Open WhatsApp and send <span class="kbd">HI</span> to our number.</li>
            <li>Tap <span class="kbd">Start Course</span> to begin.</li>
            <li>Use <span class="kbd">Next</span>, <span class="kbd">Pause</span> and <span class="kbd">Resume</span> as you go.</li>
          </ol>
        </div>
        <button class="link-btn" id="againBtn" type="button">Enrol someone else</button>
      </div>
    </aside>
  </main>

  <footer><div class="foot-inner"><span>&copy; Ekatra &middot; Learning on WhatsApp</span><span>Reply STOP on WhatsApp at any time to unsubscribe.</span></div></footer>

  <script>
    const $ = (id) => document.getElementById(id);
    const grid = $('courseGrid'), nameInput = $('name'), phoneInput = $('phoneNumber'),
      consent = $('consent'), btn = $('registerBtn'), btnLabel = $('btnLabel'),
      errorMsg = $('errorMsg'), successMsg = $('successMsg');
    const GRADIENTS = [
      'linear-gradient(135deg,#0056D2,#4C8DF6)', 'linear-gradient(135deg,#7B3FE4,#B58BFF)',
      'linear-gradient(135deg,#0F8B6D,#41C9A2)', 'linear-gradient(135deg,#D9480F,#FF8A4C)',
      'linear-gradient(135deg,#C2255C,#F06595)', 'linear-gradient(135deg,#1C7ED6,#22B8CF)'
    ];
    const ICON_CLOCK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
    const ICON_BOOK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/></svg>';
    const ICON_TICK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    let courses = [], selectedId = null;

    const gradientFor = (id) => GRADIENTS[Math.abs(Number(id)) % GRADIENTS.length];
    const lessons = (n) => n + (n === 1 ? ' lesson' : ' lessons');

    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function renderCourses() {
      grid.innerHTML = '';
      if (!courses.length) {
        grid.appendChild(el('div', 'empty', 'No courses are open for enrolment right now. Please check back soon.'));
        return;
      }
      courses.forEach((c) => {
        const card = el('button', 'card' + (c.id === selectedId ? ' selected' : ''));
        card.type = 'button';
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-checked', String(c.id === selectedId));

        const thumb = el('div', 'thumb');
        thumb.style.background = gradientFor(c.id);
        thumb.appendChild(el('span', 'thumb-label', 'WhatsApp course'));
        const tick = el('span', 'tick'); tick.innerHTML = ICON_TICK;

        const body = el('div', 'card-body');
        body.appendChild(el('div', 'card-org', 'Ekatra'));
        body.appendChild(el('div', 'card-title', c.title));
        body.appendChild(el('div', 'card-desc', c.description || 'A short, self-paced course delivered on WhatsApp.'));
        const meta = el('div', 'card-meta');
        const m1 = el('span'); m1.innerHTML = ICON_BOOK; m1.appendChild(document.createTextNode(lessons(c.lessonCount)));
        const m2 = el('span'); m2.innerHTML = ICON_CLOCK; m2.appendChild(document.createTextNode('Self-paced'));
        meta.appendChild(m1); meta.appendChild(m2);
        body.appendChild(meta);

        card.appendChild(tick); card.appendChild(thumb); card.appendChild(body);
        card.addEventListener('click', () => selectCourse(c.id, true));
        grid.appendChild(card);
      });
    }

    function selectCourse(id, scroll) {
      selectedId = id;
      renderCourses();
      const c = courses.find((x) => x.id === id);
      const box = $('selectedCourse');
      if (c) {
        $('scThumb').style.background = gradientFor(c.id);
        $('scTitle').textContent = c.title;
        $('scMeta').textContent = lessons(c.lessonCount) + ' \\u00b7 Self-paced';
        box.classList.add('show');
        if (scroll && window.matchMedia('(max-width: 980px)').matches) $('enrol').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else { box.classList.remove('show'); }
      validate();
    }

    async function loadCourses() {
      try {
        const org = new URLSearchParams(window.location.search).get('org');
        const resp = await fetch('/register/courses' + (org ? '?org=' + encodeURIComponent(org) : ''));
        const data = await resp.json();
        courses = data.courses || [];
        if (courses.length === 1) selectedId = courses[0].id;
        renderCourses();
        if (selectedId != null) selectCourse(selectedId, false);
      } catch {
        grid.innerHTML = '';
        grid.appendChild(el('div', 'empty', 'We could not load the courses. Please refresh the page.'));
      }
    }

    function validate() {
      btn.disabled = !(selectedId != null && nameInput.value.trim() && phoneInput.value.trim() && consent.checked);
      errorMsg.classList.remove('show');
    }
    [nameInput, phoneInput].forEach((e) => e.addEventListener('input', validate));
    consent.addEventListener('change', validate);

    function setBusy(busy) {
      btn.classList.toggle('loading', busy);
      btn.disabled = busy;
      btnLabel.textContent = busy ? 'Enrolling...' : 'Enrol now';
    }
    function showError(msg) {
      errorMsg.textContent = msg;
      errorMsg.classList.add('show');
    }

    btn.addEventListener('click', async () => {
      setBusy(true);
      errorMsg.classList.remove('show');
      try {
        const org = new URLSearchParams(window.location.search).get('org');
        const resp = await fetch('/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameInput.value.trim(), phoneNumber: phoneInput.value.trim(),
            courseId: selectedId, consent: consent.checked, ...(org ? { org } : {}) }),
        });
        const data = await resp.json();
        if (resp.ok) {
          successMsg.textContent = data.message;
          $('formView').style.display = 'none';
          $('successView').classList.add('show');
          if (window.matchMedia('(max-width: 980px)').matches) $('enrol').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          showError(data.error || 'Registration failed');
          setBusy(false); validate(); errorMsg.classList.add('show');
        }
      } catch {
        showError('Network error. Please try again.');
        setBusy(false); validate(); errorMsg.classList.add('show');
      }
    });

    $('againBtn').addEventListener('click', () => {
      nameInput.value = ''; phoneInput.value = ''; consent.checked = false;
      selectedId = courses.length === 1 ? courses[0].id : null;
      $('successView').classList.remove('show');
      $('formView').style.display = 'block';
      renderCourses();
      if (selectedId != null) selectCourse(selectedId, false); else { $('selectedCourse').classList.remove('show'); validate(); }
      setBusy(false); validate();
    });

    loadCourses();
  </script>
</body>
</html>`;
}
