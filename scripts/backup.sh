#!/usr/bin/env bash
# Nightly database backup. Usage: DATABASE_URL=postgres://... BACKUP_DIR=/var/backups/twiqo ./scripts/backup.sh
# Keeps the newest KEEP backups (default 14). Copy BACKUP_DIR off the machine too (object storage, another region): a backup on the same disk is not a backup.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"; BACKUP_DIR="${BACKUP_DIR:-./backups}"; KEEP="${KEEP:-14}"
mkdir -p "$BACKUP_DIR"; stamp="$(date -u +%Y%m%dT%H%M%SZ)"; out="$BACKUP_DIR/twiqo-$stamp.dump"
pg_dump --format=custom --no-owner --no-privileges --file="$out.partial" "$DATABASE_URL"
mv "$out.partial" "$out"
pg_restore --list "$out" > /dev/null   # fails loudly if the archive is unreadable
ls -1t "$BACKUP_DIR"/twiqo-*.dump | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "backup ok: $out ($(du -h "$out" | cut -f1))"
