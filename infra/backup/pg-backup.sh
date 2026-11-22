#!/usr/bin/env bash
# Dumps the local dev database to ./backups with a timestamp; keeps the newest 14.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="backups/${POSTGRES_DB:-kalpix_dev}-${STAMP}.sql.gz"
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$DATABASE_URL" | gzip > "$OUT"
else
  docker exec kalpix-postgres pg_dump -U "${POSTGRES_USER:-kalpix}" "${POSTGRES_DB:-kalpix_dev}" | gzip > "$OUT"
fi
ls -1t backups/*.sql.gz | tail -n +15 | xargs -r rm --
echo "Backup written: $OUT"
