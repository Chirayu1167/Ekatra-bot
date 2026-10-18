# Repository hygiene checklist

This project currently has no Git repository metadata in the supplied folder. This checklist is
therefore a commit guide, not a claim that `git status` or tracked-file inspection passed.
`reference/` is client/reference material: do not edit or commit it.

## Commit

- Application source under `src/`, project scripts under `scripts/`, tests under `tests/`, and
  required build/configuration files.
- Root and `admin-ui` package manifests and lockfiles, when dependencies change.
- Documentation, workflows, Docker configuration, and safe templates such as `.env.example`.
- `PHASE*_PROGRESS.md` and reports where retained as project records.

## Never commit

- `.env`, `.env.*` except the explicitly safe `.env.example` templates; credentials, API keys,
  tokens, certificates, or private keys.
- `data/`, SQLite databases/WAL/SHM files, `media/` learner uploads, backups, or database dumps.
- `reference/`, downloaded archives (`*.zip`), `node_modules/`, build output (`dist/`,
  `admin-ui/dist/`), coverage output, logs, and local temporary files.
- Real learner phone numbers, message bodies, or production data in fixtures, reports, or logs.

Root `.gitignore` excludes these paths and secret-file patterns while allowing `.env.example`.
Root ESLint ignores `reference/` and `admin-ui/`; root Vitest includes only `tests/**/*.test.ts`.
`.dockerignore` excludes reference folders, zip archives, Git metadata, dependencies, generated
builds, and local databases. The Docker build intentionally includes only the app's `media/`
directory because the runtime image ships its non-secret sample attachments; runtime media should
be mounted separately and must never contain credentials.

Before initializing Git, run a path-only secret-pattern scan locally and review any flagged paths
without printing secret values. The current workspace is not a Git repository, so tracked versus
untracked status cannot be established here. A local `.env` path was present during the scan; its
contents were not opened or printed and the ignore rule protects it.
