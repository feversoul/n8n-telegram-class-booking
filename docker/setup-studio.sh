#!/bin/sh
# Runs once, when the Postgres volume is first created (after install.sql):
# copies the studio settings from the environment into studio.settings.
# To change them later:  docker compose exec postgres psql -U studio -d studio \
#   -c "SELECT studio.setup(studio_name => 'New name');"
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v token="${TELEGRAM_BOT_TOKEN:-}" \
  -v name="${STUDIO_NAME:-Studio}" \
  -v tz="${STUDIO_TIMEZONE:-UTC}" \
  -v api="${TELEGRAM_API_BASE:-https://api.telegram.org}" \
  -v calendar="${WEBHOOK_URL%/}/webhook/studio-calendar" <<'SQL'
SELECT studio.setup(
  bot_token    => :'token',
  studio_name  => :'name',
  timezone     => :'tz',
  telegram_api => :'api',
  calendar_url => :'calendar'
);
SQL
