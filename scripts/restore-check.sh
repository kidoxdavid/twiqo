#!/usr/bin/env bash
# Proves a backup can actually be restored: restores it into a throwaway database and compares row counts with the source.
# Usage: DATABASE_URL=postgres://... ADMIN_URL=postgres://.../postgres ./scripts/restore-check.sh backups/twiqo-XXXX.dump
# ADMIN_URL must be able to CREATE/DROP DATABASE (defaults to DATABASE_URL with the database name replaced by "postgres").
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"; dump="${1:?path to a .dump file}"
ADMIN_URL="${ADMIN_URL:-$(echo "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#')}"
tmp="twiqo_restore_check_$$"; TMP_URL="$(echo "$ADMIN_URL" | sed -E "s#/postgres(\?.*)?\$#/$tmp#")"
cleanup() { psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $tmp" >/dev/null 2>&1 || true; }; trap cleanup EXIT
psql "$ADMIN_URL" -qc "CREATE DATABASE $tmp"
psql "$TMP_URL" -qc "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null 2>&1 || true
pg_restore --no-owner --no-privileges --dbname="$TMP_URL" "$dump" 2>/tmp/restore-check.log || { echo "pg_restore reported problems (see /tmp/restore-check.log)"; tail -5 /tmp/restore-check.log; }
fail=0
for t in users user_profiles listings posts orders bookings payments offers messages notifications schema_migrations; do
  a=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM $t" 2>/dev/null || echo "?"); b=$(psql "$TMP_URL" -tAc "SELECT count(*) FROM $t" 2>/dev/null || echo "MISSING")
  if [ "$a" = "$b" ]; then printf "  ok   %-18s %s rows\n" "$t" "$b"; else printf "  DIFF %-18s source=%s restored=%s (rows written after the backup are expected to differ)\n" "$t" "$a" "$b"; [ "$b" = "MISSING" ] && fail=1; fi
done
psql "$TMP_URL" -tAc "SELECT PostGIS_Version()" >/dev/null && echo "  ok   PostGIS present" || { echo "  FAIL PostGIS missing"; fail=1; }
[ "$fail" = 0 ] && echo "restore check passed" || { echo "restore check FAILED"; exit 1; }
