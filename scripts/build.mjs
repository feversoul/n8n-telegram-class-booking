// Builds workflows/*.json from src/*.js.
//
// The workflows are plain n8n exports: import them and they run, no build
// needed. This script exists so the JavaScript inside the Code nodes can live
// in real files (readable diffs, unit tests) instead of inside JSON strings.
// After changing anything under src/, run:  node scripts/build.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The part of a src file that goes into a Code node: everything above the
// unit-test exports.
export function source(name) {
  const text = readFileSync(join(root, 'src', `${name}.js`), 'utf8');
  return text.split('// --- exports for the unit tests')[0].trimEnd();
}

const uuid = (seed) => {
  const hex = createHash('sha1').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// Credentials are matched by name on import: create them with exactly these
// names before importing and every node picks them up.
const POSTGRES = { postgres: { id: 'studioBotPostgres', name: 'Studio Bot Postgres' } };
const TELEGRAM = { telegramApi: { id: 'studioBotTelegram', name: 'Studio Bot Telegram' } };

function workflow(id, name, build) {
  const nodes = [];
  const connections = {};
  const api = {
    node(nodeName, type, typeVersion, position, parameters, extra = {}) {
      nodes.push({
        parameters,
        id: uuid(`${id}/${nodeName}`),
        name: nodeName,
        type: `n8n-nodes-base.${type}`,
        typeVersion,
        position,
        ...extra,
      });
      return nodeName;
    },
    // Every database step looks the same: one function, one JSON argument.
    // Chat input only ever reaches Postgres as a bound parameter.
    postgres(nodeName, fn, argument, position, extra = {}) {
      return api.node(
        nodeName,
        'postgres',
        2.5,
        position,
        {
          operation: 'executeQuery',
          query: `SELECT studio.${fn}($1::jsonb) AS data;`,
          options: { queryReplacement: `={{ JSON.stringify(${argument}) }}` },
        },
        { credentials: POSTGRES, ...extra },
      );
    },
    code(nodeName, jsCode, position) {
      return api.node(nodeName, 'code', 2, position, { jsCode });
    },
    note(nodeName, content, position, width, height, color) {
      return api.node(nodeName, 'stickyNote', 1, position, { content, width, height, color });
    },
    link(from, to, output = 0) {
      connections[from] ??= { main: [] };
      while (connections[from].main.length <= output) connections[from].main.push([]);
      connections[from].main[output].push({ node: to, type: 'main', index: 0 });
    },
  };
  build(api);
  return { name, nodes, pinData: {}, connections, active: false, settings: { executionOrder: 'v1' }, id };
}

// Claim -> write -> send -> record: the same four steps deliver the outbox in
// the chat workflow (right after a reply) and in the notifier (on a timer).
function delivery(w, claimNode, x, y) {
  w.code(
    'Write notifications',
    [
      source('lib'),
      source('notify'),
      '',
      `const due = $input.first().json.data;`,
      'return notifications(due).map((message) => ({ json: message }));',
    ].join('\n'),
    [x, y],
  );
  w.node(
    'Send notification',
    'httpRequest',
    4.2,
    [x + 220, y],
    {
      method: 'POST',
      url: `={{ $('${claimNode}').first().json.data.api }}/sendMessage`,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { response: { response: { neverError: true } } },
    },
    { onError: 'continueRegularOutput' },
  );
  w.code(
    'Collect results',
    [
      '// One row per message: did Telegram take it? A message that failed stays in',
      '// the outbox and is tried again by a later run.',
      "const queued = $('Write notifications').all();",
      'const results = $input.all().map((item, index) => ({',
      '  id: queued[index].json.id,',
      '  ok: item.json.ok === true,',
      "  error: item.json.ok === true ? null : String(item.json.description ?? item.json.error?.message ?? item.json.error ?? 'send failed'),",
      '}));',
      'return [{ json: { results } }];',
    ].join('\n'),
    [x + 440, y],
  );
  w.postgres('Record deliveries', 'record_deliveries', '$json', [x + 660, y]);
  w.link(claimNode, 'Write notifications');
  w.link('Write notifications', 'Send notification');
  w.link('Send notification', 'Collect results');
  w.link('Collect results', 'Record deliveries');
}

// --- 1. Chat ----------------------------------------------------------------

const BRANCHES = [
  { key: 'home', label: 'Menu' },
  { key: 'schedule', label: 'Schedule', node: 'Schedule', fn: 'schedule' },
  { key: 'options', label: 'Options', node: 'Options', fn: 'options' },
  { key: 'days', label: 'Days', node: 'Days', fn: 'days' },
  { key: 'slots', label: 'Free times', node: 'Free times', fn: 'slots' },
  { key: 'preview', label: 'Preview', node: 'Preview', fn: 'preview' },
  { key: 'book', label: 'Book', node: 'Book', fn: 'book' },
  { key: 'bookings', label: 'My classes', node: 'My classes', fn: 'bookings' },
  { key: 'booking', label: 'Class', node: 'Class', fn: 'booking_details' },
  { key: 'cancel', label: 'Cancel', node: 'Cancel', fn: 'cancel' },
  { key: 'reschedule', label: 'Move', node: 'Move', fn: 'reschedule' },
  { key: 'people', label: 'People', node: 'People', fn: 'people' },
  { key: 'manage', label: 'Rooms and class types', node: 'Rooms and class types', fn: 'manage' },
  { key: 'calendar', label: 'Calendar links', node: 'Calendar links', fn: 'calendar' },
];

const chat = workflow('studioBotChat0001', 'Studio Bot · 1 Chat', (w) => {
  const rowHeight = 160;
  const top = -((BRANCHES.length - 1) * rowHeight) / 2;

  w.note(
    'About',
    [
      '## Studio Bot · Chat',
      'Every message and button tap comes in on the left and leaves as a reply on the right.',
      '',
      '**Begin** drops repeated updates and looks up who is writing. **Route** picks the branch. Each branch is one call to a Postgres function that checks the role and does the work. **Render** writes the reply.',
      '',
      'The words the bot says are in **Render**. The rules (no double bookings, who may do what) are in Postgres, in `db/install.sql`.',
      '',
      'To act on an event, add nodes after a branch: for example after **Book** to post new classes somewhere else.',
    ].join('\n'),
    [-60, -500],
    640,
    300,
    4,
  );

  w.node(
    'Telegram Trigger',
    'telegramTrigger',
    1.2,
    [0, 0],
    { updates: ['message', 'callback_query'], additionalFields: {} },
    { webhookId: uuid('studio-bot-telegram-webhook'), credentials: TELEGRAM },
  );
  w.postgres('Begin', 'begin', '$json', [220, 0]);
  w.code(
    'Route',
    [
      source('lib'),
      source('route'),
      '',
      "const routed = route($('Telegram Trigger').first().json, $input.first().json.data);",
      '// Nothing to do for a repeated update or a group chat: the run ends here.',
      'return routed ? [{ json: routed }] : [];',
    ].join('\n'),
    [440, 0],
  );
  w.node('Branch', 'switch', 3.2, [660, 0], {
    rules: {
      values: BRANCHES.map((branch) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: uuid(`branch/${branch.key}`),
              leftValue: '={{ $json.branch }}',
              rightValue: branch.key,
              operator: { type: 'string', operation: 'equals' },
            },
          ],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey: branch.label,
      })),
    },
    options: {},
  });
  w.code(
    'Render',
    [
      source('lib'),
      source('render'),
      '',
      "const routed = $('Route').first().json;",
      "const begin = $('Begin').first().json.data;",
      '// The Menu branch arrives straight from Route and has no database answer.',
      'const answer = $input.first().json.data ?? null;',
      'return render(routed, answer, begin).map((call) => ({ json: call }));',
    ].join('\n'),
    [1240, 0],
  );

  w.link('Telegram Trigger', 'Begin');
  w.link('Begin', 'Route');
  w.link('Route', 'Branch');
  BRANCHES.forEach((branch, index) => {
    if (!branch.node) {
      w.link('Branch', 'Render', index);
      return;
    }
    w.postgres(branch.node, branch.fn, '$json.req', [960, top + index * rowHeight]);
    w.link('Branch', branch.node, index);
    w.link(branch.node, 'Render');
  });

  // n8n's Telegram node cannot take an inline keyboard from data (its keyboard
  // is a fixed form in the editor), so replies go out as plain Bot API calls.
  w.node('Telegram API', 'httpRequest', 4.2, [1460, 0], {
    method: 'POST',
    url: "={{ $('Begin').first().json.data.api }}/{{ $json.method }}",
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.body) }}',
    options: { response: { response: { neverError: true } } },
  });
  w.code(
    'Check replies',
    [
      '// Telegram answers every call with { ok }. Two refusals are normal and are',
      '// not errors: an edit that changes nothing, and a tap on a button so old',
      '// that the acknowledgement is refused. If the message to edit is gone, the',
      '// reply is sent as a new message instead. Anything else fails the run, so',
      '// it shows up in Executions and reaches the error workflow.',
      "const calls = $('Render').all();",
      'const resend = [];',
      '$input.all().forEach((item, index) => {',
      '  const call = calls[index].json;',
      '  if (item.json.ok === true) return;',
      "  const why = String(item.json.description ?? 'no answer from Telegram');",
      "  if (call.method === 'answerCallbackQuery') return;",
      "  if (call.method === 'editMessageText') {",
      '    if (/not modified/i.test(why)) return;',
      "    if (/message to edit not found|can't be edited|MESSAGE_ID_INVALID/i.test(why)) {",
      '      const { message_id, ...body } = call.body;',
      "      resend.push({ json: { method: 'sendMessage', body } });",
      '      return;',
      '    }',
      '  }',
      '  throw new Error(`Telegram refused ${call.method}: ${why}`);',
      '});',
      'return resend;',
    ].join('\n'),
    [1680, -140],
  );
  w.node('Send instead', 'httpRequest', 4.2, [1900, -140], {
    method: 'POST',
    url: "={{ $('Begin').first().json.data.api }}/{{ $json.method }}",
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.body) }}',
    options: {},
  });
  w.link('Render', 'Telegram API');
  w.link('Telegram API', 'Check replies');
  w.link('Check replies', 'Send instead');

  w.note(
    'After the reply',
    [
      '### Tell the others',
      'A change can concern people who did not tap anything: the trainer whose class an admin moved, the admins when someone asks for access. Those messages were written to `studio.outbox` in the same transaction as the change; they are delivered here, straight after the reply.',
    ].join('\n'),
    [1620, 60],
    1080,
    330,
    5,
  );
  w.postgres('Claim outbox', 'claim_due', '{ limit: 25 }', [1680, 240], { executeOnce: true });
  w.link('Telegram API', 'Claim outbox');
  delivery(w, 'Claim outbox', 1900, 240);
});

// --- 2. Notifier ------------------------------------------------------------

const notifier = workflow('studioBotNotify01', 'Studio Bot · 2 Notifier', (w) => {
  w.note(
    'About',
    [
      '## Studio Bot · Notifier',
      'Runs on a timer and sends what has come due: reminders before a class (24 hours and 1 hour by default), the morning summary, and any message a chat run could not deliver.',
      '',
      'Timing is set in Postgres with `studio.setup(reminder_minutes => ..., digest_time => ...)`. The interval here only decides how punctual reminders are. On n8n Cloud every run counts as an execution: every 5 minutes is 288 a day, so raise it if your plan is small.',
    ].join('\n'),
    [-40, -320],
    620,
    260,
    4,
  );
  w.node('Every 5 minutes', 'scheduleTrigger', 1.2, [0, 0], {
    rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] },
  });
  w.postgres('Claim due', 'claim_due', '{ limit: 50 }', [220, 0]);
  w.link('Every 5 minutes', 'Claim due');
  delivery(w, 'Claim due', 440, 0);
});
notifier.settings.saveDataSuccessExecution = 'none';

// --- 3. Calendar feed -------------------------------------------------------

const calendar = workflow('studioBotCalendar', 'Studio Bot · 3 Calendar feed', (w) => {
  w.note(
    'About',
    [
      '## Studio Bot · Calendar feed',
      'Serves the schedule as an iCalendar feed that Google Calendar, Apple Calendar and Outlook can subscribe to. Postgres stays the source of truth; calendars only read.',
      '',
      'The link needs the secret token from `studio.settings`. Add `&room=<id>` or `&trainer=<id>` for one room or one trainer; the bot hands out ready-made links under **Calendar**.',
      '',
      'Tell the bot where this webhook lives: `SELECT studio.setup(calendar_url => \'https://<your n8n>/webhook/studio-calendar\');`',
    ].join('\n'),
    [-40, -340],
    620,
    280,
    4,
  );
  w.node(
    'Calendar link',
    'webhook',
    2,
    [0, 0],
    { httpMethod: 'GET', path: 'studio-calendar', responseMode: 'responseNode', options: {} },
    { webhookId: uuid('studio-bot-calendar-webhook') },
  );
  w.postgres('Build feed', 'ics', '$json.query ?? {}', [220, 0]);
  w.node('Answer', 'respondToWebhook', 1.1, [440, 0], {
    respondWith: 'text',
    responseBody: '={{ $json.data.body }}',
    options: {
      responseCode: '={{ $json.data.ok ? 200 : 404 }}',
      responseHeaders: {
        entries: [
          {
            name: 'Content-Type',
            value: "={{ $json.data.ok ? 'text/calendar; charset=utf-8' : 'text/plain; charset=utf-8' }}",
          },
        ],
      },
    },
  });
  w.link('Calendar link', 'Build feed');
  w.link('Build feed', 'Answer');
});

// --- 4. Error alerts --------------------------------------------------------

const errors = workflow('studioBotErrors01', 'Studio Bot · 4 Error alerts', (w) => {
  w.note(
    'About',
    [
      '## Studio Bot · Error alerts',
      'When a run of one of the other workflows fails, the admins get a Telegram message about it (at most one per ten minutes for the same error).',
      '',
      'Switch it on in each of the other three workflows: Settings, Error Workflow, pick this one.',
    ].join('\n'),
    [-40, -280],
    620,
    220,
    4,
  );
  w.node('When a run fails', 'errorTrigger', 1, [0, 0], {});
  w.postgres(
    'Queue alert',
    'alert',
    '{ workflow: $json.workflow?.name, node: $json.execution?.lastNodeExecuted, message: $json.execution?.error?.message ?? $json.trigger?.error?.message, url: $json.execution?.url }',
    [220, 0],
  );
  w.link('When a run fails', 'Queue alert');
});

// --- write ------------------------------------------------------------------

export const workflows = {
  '1-chat.json': chat,
  '2-notifier.json': notifier,
  '3-calendar-feed.json': calendar,
  '4-error-alerts.json': errors,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(root, 'workflows');
  mkdirSync(out, { recursive: true });
  for (const [file, definition] of Object.entries(workflows)) {
    writeFileSync(join(out, file), `${JSON.stringify(definition, null, 2)}\n`);
    console.log(`workflows/${file}: ${definition.nodes.length} nodes`);
  }
}
