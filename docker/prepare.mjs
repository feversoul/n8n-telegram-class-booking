// Used by bootstrap.sh inside the n8n container: writes the import files for
// the n8n CLI from the environment, so no secret is stored in the repository.
//   node prepare.mjs <workflows dir> <output dir>

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [source, out] = process.argv.slice(2);
const env = process.env;

const credentials = [
  {
    id: 'studioBotTelegram',
    name: 'Studio Bot Telegram',
    type: 'telegramApi',
    data: {
      accessToken: env.TELEGRAM_BOT_TOKEN,
      baseUrl: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    },
  },
  {
    id: 'studioBotPostgres',
    name: 'Studio Bot Postgres',
    type: 'postgres',
    data: {
      host: env.DB_POSTGRESDB_HOST,
      port: Number(env.DB_POSTGRESDB_PORT || 5432),
      database: env.DB_POSTGRESDB_DATABASE,
      user: env.DB_POSTGRESDB_USER,
      password: env.DB_POSTGRESDB_PASSWORD,
      ssl: 'disable',
      sshTunnel: false,
      maxConnections: 20,
    },
  },
];

mkdirSync(join(out, 'workflows'), { recursive: true });
writeFileSync(join(out, 'credentials.json'), JSON.stringify(credentials));

const ERRORS = 'studioBotErrors01';
for (const file of readdirSync(source).filter((name) => name.endsWith('.json'))) {
  const workflow = JSON.parse(readFileSync(join(source, file), 'utf8'));
  // Failed runs of the other three report to the error workflow. In the
  // files this link is left out, because workflow ids change on a manual import.
  if (workflow.id !== ERRORS) workflow.settings.errorWorkflow = ERRORS;
  // Optional: how often the notifier runs, in seconds (default: every 5 minutes).
  const seconds = Number(env.NOTIFIER_INTERVAL_SECONDS || 0);
  if (seconds > 0) {
    for (const node of workflow.nodes) {
      if (node.type === 'n8n-nodes-base.scheduleTrigger') {
        node.parameters.rule = { interval: [{ field: 'seconds', secondsInterval: seconds }] };
      }
    }
  }
  writeFileSync(join(out, 'workflows', file), JSON.stringify(workflow));
}
