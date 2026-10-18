#!/bin/sh
# Online Postgres backup (safe while the app is running): pg_dump custom format, compressed.
# Point-in-time recovery beyond this file is a managed-hosting decision (WAL archiving / PITR);
# see docs/learner-data-runbook.md and PHASE2_5_REPORT.md. Restores: scripts/restore.sh.
# Usage: sh scripts/backup.sh [dest]  (default: ./backups/ekatra-YYYYmmdd-HHMMSS.dump)
# Env: DATABASE_URL (required). Credentials are never printed.
set -eu
DEST="${1:-./backups/ekatra-$(date +%Y%m%d-%H%M%S).dump}"
if [ -z "${DATABASE_URL:-}" ]; then echo "DATABASE_URL is required" >&2; exit 1; fi
mkdir -p "$(dirname "$DEST")"
# Custom format (-Fc) + max compression (-Z9). -v would leak object names only, never data.
pg_dump --format=custom --compress=9 --file="$DEST" "$DATABASE_URL"
echo "backup ok: $(du -h "$DEST" | cut -f1) -> $DEST"
