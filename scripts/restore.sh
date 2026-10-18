#!/bin/sh
# Restore a pg_dump custom-format backup made by scripts/backup.sh.
# For a clean restore proof, point TARGET at an EMPTY database:
#   createdb "$TARGET" && sh scripts/restore.sh backup.dump "$TARGET"
# With --clean (default here), existing objects are dropped first; STOP THE APP FIRST
# when restoring over a live database so nothing writes mid-restore.
# Usage: sh scripts/restore.sh <backup.dump> [target-database-url]  (default: $DATABASE_URL)
# Env: DATABASE_URL (used when no target is given). Credentials are never printed.
set -eu
BACKUP="${1:-}"
TARGET="${2:-${DATABASE_URL:-}}"
if [ -z "$BACKUP" ]; then echo "usage: sh scripts/restore.sh <backup.dump> [target-url]" >&2; exit 1; fi
if [ ! -f "$BACKUP" ]; then echo "backup not found: $BACKUP" >&2; exit 1; fi
if [ -z "$TARGET" ]; then echo "no target: pass a database URL or set DATABASE_URL" >&2; exit 1; fi
pg_restore --clean --if-exists --dbname="$TARGET" "$BACKUP"
echo "restore ok: $BACKUP -> target database restored"
