// npm run test:e2e
// Starts the test stack (n8n, Postgres, the Telegram stand-in), runs
// test/e2e.test.mjs against it and removes the stack again.
// Set KEEP_STACK=1 to leave it running, for example to open the n8n editor on
// http://localhost:55678 and look at the executions.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['compose', '--env-file', 'test/test.env', '-f', 'docker-compose.yml', '-f', 'test/docker-compose.yml', '-p', 'studio-bot-test'];
const run = (command, args) => spawnSync(command, args, { cwd: root, stdio: 'inherit' }).status ?? 1;

run('docker', [...compose, 'down', '-v']);
let status = run('docker', [...compose, 'up', '-d']);
if (status === 0) status = run(process.execPath, ['--test', '--test-reporter=spec', 'test/e2e.test.mjs']);
if (status !== 0) run('docker', [...compose, 'logs', '--tail', '60', 'n8n']);
if (!process.env.KEEP_STACK) run('docker', [...compose, 'down', '-v']);
process.exit(status);
