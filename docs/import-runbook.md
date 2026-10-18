# SQLite import dry-run runbook

Use this before any cutover. The source SQLite file is opened read-only. Never point the first
attempt at the only copy of the source database or a production Postgres target.

## Prepare a protected copy

1. Stop writes to the source application or take a consistent SQLite backup using its supported
   backup procedure.
2. Copy that backup to a protected, access-controlled working directory. Keep the original
   SQLite file untouched and retain a separate backup.
3. Create/migrate an isolated Postgres database for the import check. Set `DATABASE_URL` to the
   app-role connection for that database. The CLI loads the normal environment configuration, so
   provide the required non-placeholder settings (including the opt-out hash secret) through
   the secret manager or process environment. Never paste secrets into a command committed to
   shell history.
4. Verify the SQLite copy and Postgres target are the intended files/databases before running
   the command.

## Run a counts-only dry run

From the repository root:

```powershell
npm run import:sqlite -- --sqlite "D:\protected-copy\source-copy.db" --dry-run
```

The importer opens SQLite with `readOnly: true`, reads rows, checks the Postgres schema and
returns planned per-table counts and boolean spot checks. `--dry-run` does not insert, update,
or delete rows in Postgres. Do not add `--force`; that flag is only for an explicitly approved
real import into a non-empty destination and is not appropriate for a dry run.

The JSON report contains `dryRun`, table row counts, an integrity placeholder (`orphans: -1`
because no import was performed), and boolean spot checks for completed enrollments, opt-out
hashes, certificates, and admin-key hashes. It does not print names, phone numbers, authored
content, keys, or hashes. Unsupported course content is reported by **field name and number of
affected course rows only**; the value itself is never logged. Review every warning against
`docs/course-model-mapping.md` before deciding whether the destination is safe to import.

## Fixture verification and rollback

`tests/import.test.ts` builds a disposable SQLite fixture using the shipped SQLite migrations,
executes the dry-run against isolated test Postgres, verifies planned course/enrollment counts,
and verifies no destination course row was written. The source fixture is removed after the test.
Run it with:

```powershell
npm test -- tests/import.test.ts
```

For a production dry run, retain the source and copy unchanged. If the report is unexpected,
stop: remove only the isolated disposable Postgres database after confirming its exact name with
the database operator, then correct the copy/configuration and repeat. The source SQLite file
does not require rollback because dry-run never modifies it. A real import requires a separately
approved backup, maintenance window, destination decision, and restore plan; do not infer that
approval from a successful dry run.
