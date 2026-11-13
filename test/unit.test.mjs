// Fast checks that need no Docker: the router, the screens, and that the
// workflow files match the sources.   npm test

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { workflows } from '../scripts/build.mjs';

// Load src files the way a Code node gets them: pasted one after another.
function load(...names) {
  const code = names.map((name) => readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8')).join('\n');
  const module = { exports: {} };
  new Function('module', code)(module);
  return module.exports;
}

const lib = load('lib');
const { route } = load('lib', 'route');
const { render, SCREENS } = load('lib', 'render');
const { notifications, leadTime } = load('lib', 'notify');

const begin = (overrides = {}) => ({
  api: 'https://api.telegram.org/botTOKEN',
  me: { id: 1, tg: 100, name: 'Dana', role: 'admin', status: 'active', is_new: false, ...overrides },
  studio: { name: 'Flex', calendar: true, rooms: 2, classes: 2 },
  today: '2026-11-13',
  awaiting: null,
});
const tap = (data) => ({ update_id: 1, callback_query: { id: 'q', from: { id: 100 }, data, message: { message_id: 7, chat: { id: 100, type: 'private' } } } });
const say = (text) => ({ update_id: 1, message: { message_id: 3, from: { id: 100 }, chat: { id: 100, type: 'private' }, text } });

test('commands and buttons land on the right branch', () => {
  const cases = [
    [say('/start'), 'home', 'home'],
    [say('/book'), 'options', 'book_class'],
    [say('/schedule@my_bot'), 'schedule', 'schedule'],
    [say('/nonsense'), 'home', 'home'],
    [say('hello'), 'home', 'home'],
    [tap('b:c2'), 'options', 'book_room'],
    [tap('b:c2:r1'), 'days', 'book_day'],
    [tap('b:c2:r1:w2'), 'days', 'book_day'],
    [tap('b:c2:r1:d20261114'), 'slots', 'book_time'],
    [tap('b:d20261114'), 'options', 'book_class'],
    [tap('b:c2:r1:d20261114:t0900'), 'preview', 'book_confirm'],
    [tap('b:c2:r1:d20261114:t0900:p0'), 'options', 'book_trainer'],
    [tap('B:c2:r1:d20261114:t0900:n4'), 'book', 'booked'],
    [tap('B:c2:r1:d20261114'), 'slots', 'book_time'],
    [tap('e:12'), 'days', 'move_day'],
    [tap('e:12:r0'), 'options', 'move_room'],
    [tap('e:12:r3:d20261114'), 'slots', 'move_time'],
    [tap('E:12:r3:d20261114:t1000'), 'reschedule', 'moved'],
    [tap('X:12:f'), 'cancel', 'cancelled'],
    [tap('ps:2:admin'), 'people', 'person'],
    [tap('rn'), 'manage', 'ask'],
    [tap('cal'), 'calendar', 'calendar'],
  ];
  for (const [update, branch, screen] of cases) {
    const routed = route(update, begin());
    assert.deepEqual([routed.branch, routed.screen], [branch, screen], JSON.stringify(update.callback_query?.data ?? update.message.text));
    assert.equal(routed.req.tg, 100);
  }
  assert.deepEqual(route(tap('B:c2:r1:d20261114:t0900:n4'), begin()).req, { tg: 100, class: 2, room: 1, day: '2026-11-14', time: '09:00', repeat: 4 });
});

test('button data that is not ours never reaches the database as a date, time or id', () => {
  for (const junk of ['b:c2:r1:d20261399', 'b:c2:r1:d2026-11-14', 'b:c2:r1:d20261114:t2460', "b:c1;DROP:r1'--", 'b:cNaN:r-1', 'e:abc', 'v:1e9', 'zzz', '']) {
    const routed = route(tap(junk), begin());
    assert.ok(routed, junk);
    for (const [key, value] of Object.entries(routed.req)) {
      if (key === 'day') assert.match(value, /^\d{4}-\d{2}-\d{2}$/, junk);
      else if (key === 'time') assert.match(value, /^\d{2}:\d{2}$/, junk);
      else assert.ok(Number.isSafeInteger(value) || typeof value === 'boolean', `${junk}: ${key}=${value}`);
    }
  }
  assert.equal(route(tap('b:c2:r1:d20261399'), begin()).screen, 'book_day', 'an impossible date is dropped');
});

test('people without access only ever get the waiting or blocked screen', () => {
  for (const status of ['pending', 'blocked']) {
    for (const update of [say('/book'), tap('B:c2:r1:d20261114:t0900'), tap('pl'), say('Studio X')]) {
      const routed = route(update, begin({ status }));
      assert.deepEqual([routed.branch, routed.screen], ['home', status]);
    }
  }
  assert.equal(route(say('/start'), { skip: 'duplicate update' }), null);
});

test('a typed answer is only used when the bot asked for one', () => {
  assert.equal(route(say('Studio C, 20'), begin()).branch, 'home');
  const asked = { ...begin(), awaiting: { kind: 'room_new', data: {} } };
  assert.deepEqual(route(say('Studio C, 20'), asked).req, { tg: 100, op: 'input', text: 'Studio C, 20' });
});

// Every screen, drawn with the largest ids the database could plausibly hold.
function everyScreen() {
  const big = 99_999_999;
  const b = { id: big, class: 'Yoga <Flow> & "Stretch"', minutes: 60, room: 'Loft <2> & Deck', room_id: big, trainer: 'Ben <b>&', trainer_id: big, day: '2026-11-14', from: '09:00', to: '10:00', status: 'confirmed', mine: false, upcoming: true, can_edit: true, following: 3 };
  const plan = { class: { id: big, name: b.class }, minutes: 60, room: { id: big + 1, name: b.room }, trainer: { id: big, name: b.trainer, self: false }, booking: b };
  const days = Array.from({ length: 7 }, (_, i) => ({ day: lib.addDays('2026-11-13', i), free: i % 3 === 0 ? 0 : 31 }));
  const slots = Array.from({ length: 31 }, (_, i) => `${String(6 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
  const wizSteps = { c: String(big), r: String(big), d: '20261114', t: '0900', p: String(big), n: '12', w: '8' };
  const book = { base: 'b', steps: wizSteps };
  const move = { base: `e:${big}`, steps: { r: String(big), d: '20261114', t: '0900', w: '8' } };
  const person = (status, role) => ({ ok: true, note: null, person: { id: big, name: b.trainer, username: 'ben', role, status, self: false, upcoming: 2 } });
  const options = { ok: true, plan, classes: [{ id: big, name: b.class, minutes: 60 }], rooms: [{ id: big, name: b.room, capacity: 20 }], trainers: [{ id: big, name: b.trainer, self: false }] };
  const schedule = { ok: true, day: '2026-11-14', opens: '06:00', closes: '22:00', closed: false, past: false, bookable: true, rooms: [{ id: big, name: b.room, capacity: 20, classes: [b], free: [{ from: '06:00', to: '09:00' }] }] };
  return [
    ['home', null, {}], ['help', null, {}], ['pending', null, {}], ['blocked', null, {}],
    ['schedule', schedule, {}], ['day_classes', schedule, {}],
    ['book_class', options, book], ['book_room', options, book], ['book_trainer', options, book],
    ['book_day', { ok: true, plan, days, week: 8, more: true }, book],
    ['book_time', { ok: true, plan, day: '2026-11-14', slots, trainer_busy: 2, room_busy: 1 }, book],
    ['book_confirm', { ok: true, plan, day: '2026-11-14', from: '09:00', to: '10:00', free: true, why: null, is_admin: true }, book],
    ['book_confirm', { ok: true, plan, day: '2026-11-14', from: '09:00', to: '10:00', free: false, why: 'room', is_admin: true }, book],
    ['booked', { ok: true, booked: [b], skipped: [], weeks: 1 }, book],
    ['booked', { ok: true, booked: [b, b], skipped: [{ day: '2026-11-28', why: 'room' }], weeks: 3 }, book],
    ['booked', { ok: false, error: 'taken', why: 'room', plan, day: '2026-11-14', time: '09:00', slots }, book],
    ['mine', { ok: true, items: [b, b], page: 1, total: 20, more: true }, {}],
    ['view', { ok: true, booking: b }, {}],
    ['cancel_confirm', { ok: true, booking: b }, {}],
    ['cancelled', { ok: true, booking: b, count: 4 }, {}],
    ['move_room', options, move], ['move_day', { ok: true, plan, days, week: 8, more: true }, move],
    ['move_time', { ok: true, plan, day: '2026-11-14', slots, trainer_busy: 0, room_busy: 0 }, move],
    ['move_confirm', { ok: true, plan, day: '2026-11-21', from: '10:00', to: '11:00', free: true }, move],
    ['moved', { ok: true, booking: b, was: b }, move],
    ['moved', { ok: false, error: 'taken', why: 'trainer', plan, day: '2026-11-14', time: '09:00', slots }, move],
    ['people', { ok: true, people: [person('pending', 'trainer').person, person('active', 'admin').person, person('blocked', 'trainer').person] }, {}],
    ['person', person('pending', 'trainer'), {}], ['person', person('active', 'admin'), {}], ['person', person('blocked', 'trainer'), {}],
    ['ask', { ok: true, asking: 'room_rename', current: b.room }, {}],
    ['manage', { ok: true, list: 'rooms', rooms: [{ id: big, name: b.room, capacity: 20, active: true, upcoming: 3 }] }, {}],
    ['manage', { ok: true, list: 'classes', classes: [{ id: big, name: b.class, minutes: 60, active: false }] }, {}],
    ['manage', { ok: false, error: 'duplicate', asking: 'room_new', name: b.room }, {}],
    ['calendar', { ok: true, mine: 'https://n8n.example.com/webhook/studio-calendar?token=abc&trainer=1', studio: 'https://n8n.example.com/webhook/studio-calendar?token=abc', rooms: [{ name: b.room, url: 'https://n8n.example.com/webhook/studio-calendar?token=abc&room=1' }] }, {}],
    ['view', { ok: false, error: 'forbidden' }, {}],
  ].map(([screen, data, wiz]) => ({ screen, data, wiz }));
}

test('every screen: buttons fit in 64 bytes, text is valid Telegram HTML, nothing is left unescaped', () => {
  assert.deepEqual([...new Set(everyScreen().map((s) => s.screen))].sort(), Object.keys(SCREENS).sort(), 'every screen is covered');
  for (const { screen, data, wiz } of everyScreen()) {
    const routed = { screen, wiz, reply: { chat_id: 100, message_id: 7, callback_id: 'q' } };
    const calls = render(routed, data, begin());
    assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery', 'editMessageText'], screen);
    const { text, reply_markup: markup } = calls[1].body;
    assert.ok(text.length > 0 && text.length <= 4096, screen);
    assert.doesNotMatch(text, /undefined|NaN|\[object/, `${screen}: ${text}`);
    const withoutTags = text.replace(/<\/?(b|code)>/g, '');
    assert.doesNotMatch(withoutTags, /[<>]/, `${screen}: stray angle bracket in ${text}`);
    assert.doesNotMatch(withoutTags, /&(?!(amp|lt|gt);)/, `${screen}: bare ampersand in ${text}`);
    for (const b of (markup?.inline_keyboard ?? []).flat()) {
      assert.ok(b.text.length > 0, screen);
      assert.ok(Buffer.byteLength(b.callback_data) <= 64, `${screen}: ${b.callback_data}`);
      assert.doesNotMatch(b.text + b.callback_data, /undefined|NaN/, `${screen}: ${b.text} ${b.callback_data}`);
    }
  }
});

test('a command gets a new message, a tap edits the message it came from', () => {
  const sent = render({ screen: 'home', reply: { chat_id: 100, message_id: null, callback_id: null } }, null, begin());
  assert.deepEqual(sent.map((c) => c.method), ['sendMessage']);
  assert.equal(sent[0].body.parse_mode, 'HTML');
  const home = sent[0].body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(home.includes('pl'));
  const trainer = render({ screen: 'home', reply: { chat_id: 100, message_id: null, callback_id: null } }, null, begin({ role: 'trainer' }));
  assert.ok(!trainer[0].body.reply_markup.inline_keyboard.flat().some((b) => ['pl', 'ro', 'cl'].includes(b.callback_data)));
});

test('notifications are written for every kind the database queues', () => {
  const sqlText = readFileSync(new URL('../db/install.sql', import.meta.url), 'utf8');
  const kinds = [...sqlText.matchAll(/'(access_request|access_granted|booked|moved|cancelled|reminder|digest|alert)'/g)].map((m) => m[1]);
  const b = { id: 5, class: 'Yoga & <Flow>', minutes: 60, room: 'Loft', trainer: 'Anna', day: '2026-11-14', from: '09:00', to: '10:00' };
  const payloads = {
    access_request: { person_id: 2, name: 'A <b>', username: 'a' },
    access_granted: { role: 'trainer', first_time: true },
    booked: { actor: 'Dana', yours: true, count: 4, booking: b },
    moved: { actor: 'Dana', yours: false, booking: b, was: b },
    cancelled: { actor: 'Dana', yours: true, count: 1, booking: b },
    reminder: { minutes: 60, booking: b },
    digest: { day: '2026-11-13', classes: [b] },
    alert: { workflow: 'Chat', node: 'Book', message: 'boom <x>', url: 'https://n8n/e/1?a=1&b=2' },
  };
  for (const kind of new Set(kinds)) assert.ok(payloads[kind], `no test payload for ${kind}`);
  const out = notifications({ studio: { name: 'Flex' }, today: '2026-11-13', messages: Object.entries(payloads).map(([kind, payload], i) => ({ id: i, chat_id: 100, kind, payload })) });
  assert.equal(out.length, Object.keys(payloads).length);
  for (const message of out) {
    const bare = message.body.text.replace(/<\/?(b|code)>/g, '');
    assert.doesNotMatch(bare, /[<>]|&(?!(amp|lt|gt);)|undefined/, message.body.text);
    for (const btn of (message.body.reply_markup?.inline_keyboard ?? []).flat()) assert.ok(Buffer.byteLength(btn.callback_data) <= 64);
  }
  assert.deepEqual([1440, 60, 120, 30, 2880].map(leadTime), ['Tomorrow at this time', 'In 1 hour', 'In 2 hours', 'In 30 minutes', 'In 2 days']);
});

test('workflow files are up to date with src/ and only call functions that exist', () => {
  const sqlText = readFileSync(new URL('../db/install.sql', import.meta.url), 'utf8');
  for (const [file, built] of Object.entries(workflows)) {
    const onDisk = JSON.parse(readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8'));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(built)), `${file} is stale: run node scripts/build.mjs`);
    const names = new Set(built.nodes.map((n) => n.name));
    assert.equal(names.size, built.nodes.length, `${file}: duplicate node name`);
    for (const [from, links] of Object.entries(built.connections)) {
      assert.ok(names.has(from), `${file}: ${from}`);
      for (const link of links.main.flat()) assert.ok(names.has(link.node), `${file}: ${link.node}`);
    }
    for (const node of built.nodes.filter((n) => n.type.endsWith('.postgres'))) {
      const fn = node.parameters.query.match(/^SELECT studio\.(\w+)\(\$1::jsonb\) AS data;$/)?.[1];
      assert.ok(fn && sqlText.includes(`FUNCTION studio.${fn}(`), `${file}: ${node.name} calls ${node.parameters.query}`);
    }
    assert.doesNotMatch(JSON.stringify(built), /\d{6,}:[A-Za-z0-9_-]{30,}/, `${file}: looks like a bot token`);
  }
});
