/**
 * Ordered schema migrations. The array index + 1 is the schema version, stored in SQLite's
 * `PRAGMA user_version`. NEVER edit a migration that has shipped: append a new one instead.
 */
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export const MIGRATIONS: readonly string[] = [
  // 1 — courses, lessons, lesson content, enrollments, processed webhook ids
  `
  CREATE TABLE courses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    created_at  TEXT NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT NOT NULL DEFAULT (${NOW})
  );

  -- Lesson positions are 1..N within a course. No CHECK on position on purpose: deleting a
  -- lesson renumbers via a temporary negative position (see CourseService.deleteLesson).
  CREATE TABLE lessons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (${NOW}),
    updated_at TEXT NOT NULL DEFAULT (${NOW}),
    UNIQUE (course_id, position)
  );

  -- One row per piece of lesson content, in delivery order.
  --   text   : text = the message body
  --   image / document / video / audio : url = public https URL, text = optional caption
  --   link   : url = the link, text = optional label
  CREATE TABLE lesson_items (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL CHECK (position >= 1),
    kind      TEXT NOT NULL CHECK (kind IN ('text', 'image', 'document', 'video', 'audio', 'link')),
    text      TEXT,
    url       TEXT,
    UNIQUE (lesson_id, position)
  );

  -- last_delivered_position = highest lesson whose messages were SUCCESSFULLY sent (0 = none).
  -- Completion lives on this row (status + completed_at), so there can never be two
  -- completion records for one learner/course.
  -- Status 'pending' = pre-enrolled via dashboard but hasn't started the course yet.
  CREATE TABLE enrollments (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 TEXT NOT NULL,
    course_id               INTEGER NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
    status                  TEXT NOT NULL CHECK (status IN ('pending', 'active', 'paused', 'completed')),
    last_delivered_position INTEGER NOT NULL DEFAULT 0 CHECK (last_delivered_position >= 0),
    started_at              TEXT NOT NULL DEFAULT (${NOW}),
    updated_at              TEXT NOT NULL DEFAULT (${NOW}),
    completed_at            TEXT,
    UNIQUE (user_id, course_id)
  );

  -- A learner can have at most ONE active course; any number may be paused or completed.
  CREATE UNIQUE INDEX one_active_enrollment_per_user ON enrollments(user_id) WHERE status = 'active';
  CREATE INDEX enrollments_by_course ON enrollments(course_id);

  -- Twilio MessageSids we have already handled (webhook de-duplication).
  CREATE TABLE processed_messages (
    message_sid TEXT PRIMARY KEY,
    claimed_at  TEXT NOT NULL DEFAULT (${NOW})
  );
  `,

  // 3 — add 'quiz' kind and options column to lesson_items
  `
  -- SQLite doesn't support ALTER TABLE to modify CHECK constraints directly.
  -- We recreate the table with the new constraint and column.
  CREATE TABLE lesson_items_new (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL CHECK (position >= 1),
    kind      TEXT NOT NULL CHECK (kind IN ('text', 'image', 'document', 'video', 'audio', 'link', 'quiz')),
    text      TEXT,
    url       TEXT,
    options   TEXT, -- JSON string for quiz options
    UNIQUE (lesson_id, position)
  );
  INSERT INTO lesson_items_new (id, lesson_id, position, kind, text, url)
  SELECT id, lesson_id, position, kind, text, url FROM lesson_items;
  DROP TABLE lesson_items;
  ALTER TABLE lesson_items_new RENAME TO lesson_items;
  `,

  // 2 — learners who sent STOP. A row means "do not message this learner".
  `
  CREATE TABLE opt_outs (
    user_id      TEXT PRIMARY KEY,
    opted_out_at TEXT NOT NULL DEFAULT (${NOW})
  );
  `,

  // 4 — learner profile (name + consent captured at web registration) and completion
  // certificates. One certificate per enrollment (UNIQUE) so a repeated or racing completion
  // can never create a second record. A certificate is a completion record, not accreditation.
  `
  CREATE TABLE learners (
    user_id      TEXT PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT '',
    consented_at TEXT NOT NULL DEFAULT (${NOW}),
    updated_at   TEXT NOT NULL DEFAULT (${NOW})
  );

  CREATE TABLE certificates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    enrollment_id INTEGER NOT NULL UNIQUE REFERENCES enrollments(id) ON DELETE RESTRICT,
    code          TEXT NOT NULL UNIQUE,
    learner_name  TEXT NOT NULL,
    course_title  TEXT NOT NULL,
    issued_at     TEXT NOT NULL DEFAULT (${NOW})
  );
  `,

  // 5 — quiz answers. One row per enrollment + lesson position: the learner's first
  // answer unlocks NEXT for that lesson. Re-answers still get feedback but keep the first row.
  `
  CREATE TABLE quiz_answers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL CHECK (position >= 1),
    chosen        INTEGER NOT NULL CHECK (chosen >= 0),
    correct       INTEGER NOT NULL CHECK (correct IN (0, 1)),
    answered_at   TEXT NOT NULL DEFAULT (${NOW}),
    UNIQUE (enrollment_id, position)
  );
  `,

  // 6 — organisations and tenant isolation. Every course and enrollment belongs to one org.
  // Existing rows are backfilled to the seeded "default" org. Admin users/keys/audit land here
  // too; role checks and key verification live in the auth layer (Phase 2, Task 3).
  `
  CREATE TABLE organisations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (${NOW})
  );
  INSERT INTO organisations (slug, name) VALUES ('default', 'Default');

  -- SQLite forbids ADD COLUMN with both REFERENCES and a non-NULL default, so the column
  -- lands nullable and is backfilled explicitly. All service writes supply org_id afterwards.
  ALTER TABLE courses ADD COLUMN org_id INTEGER REFERENCES organisations(id);
  ALTER TABLE enrollments ADD COLUMN org_id INTEGER REFERENCES organisations(id);
  UPDATE courses SET org_id = (SELECT id FROM organisations WHERE slug = 'default') WHERE org_id IS NULL;
  UPDATE enrollments SET org_id = (SELECT id FROM organisations WHERE slug = 'default') WHERE org_id IS NULL;
  CREATE INDEX courses_by_org ON courses(org_id);
  CREATE INDEX enrollments_by_org_user ON enrollments(org_id, user_id);

  -- org_id NULL = platform scope (platform_admin). Others must reference their own org.
  CREATE TABLE admin_users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER REFERENCES organisations(id) ON DELETE RESTRICT,
    name       TEXT NOT NULL DEFAULT '',
    role       TEXT NOT NULL CHECK (role IN ('platform_admin', 'org_admin', 'instructor')),
    created_at TEXT NOT NULL DEFAULT (${NOW}),
    CHECK ((role = 'platform_admin' AND org_id IS NULL) OR (role != 'platform_admin' AND org_id IS NOT NULL))
  );

  -- Only the SHA-256 hash of a key is stored; the plaintext is shown once at creation.
  CREATE TABLE admin_api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    key_hash     TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (${NOW}),
    last_used_at TEXT,
    revoked_at   TEXT,
    expires_at   TEXT
  );
  CREATE INDEX admin_api_keys_by_hash ON admin_api_keys(key_hash);

  CREATE TABLE audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    org_id        INTEGER REFERENCES organisations(id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    target        TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (${NOW})
  );
  CREATE INDEX audit_log_by_org_time ON audit_log(org_id, created_at);
  `,

  // 7 — opt-out survives learner deletion (hashed number) + active-course rule becomes per-org.
  `
  ALTER TABLE opt_outs ADD COLUMN phone_hash TEXT;
  CREATE UNIQUE INDEX opt_outs_by_hash ON opt_outs(phone_hash);
  DROP INDEX one_active_enrollment_per_user;
  CREATE UNIQUE INDEX one_active_enrollment_per_org_user ON enrollments(user_id, org_id) WHERE status = 'active';
  `,
];
