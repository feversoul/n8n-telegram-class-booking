// End-to-end: the four workflows as shipped, on a real n8n and a real
// Postgres, with mock-telegram.mjs standing in for api.telegram.org.
// Each test is a piece of one story and they run in order.
//
//   npm run test:e2e        (starts the stack, runs this file, stops the stack)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { MOCK, Person, lastSeq, mockState, post, quiet, sql, waitForWebhook } from './harness.mjs';

const { addDays, dayName, packDay } = createRequire(import.meta.url)('../src/lib.js');

const dana = new Person(9100, 'Dana', 'dana'); // becomes the admin
const anna = new Person(9200, 'Anna', 'anna_yoga'); // trainer
const ben = new Person(9300, 'Ben <b>&', undefined); // trainer whose name needs escaping
const carol = new Person(9400, 'Carol', 'carol'); // asks for access later

let today;
let tomorrow;
const ids = {};

// Walk the booking flow up to the confirmation card.
async function toConfirm(person, { klass, room, day, time }) {
  await person.say('/book');
  await person.tap(klass);
  await person.tap(room);
  await person.tap(dayName(day));
  return person.tap(time);
}

const count = (where) => Number(sql(`SELECT count(*) FROM studio.booking WHERE ${where}`));

before(async () => {
  await waitForWebhook();
  sql(`TRUNCATE studio.person, studio.room, studio.class_type, studio.booking, studio.booking_event,
       studio.outbox, studio.reminder_sent, studio.digest_sent, studio.processed_update, studio.chat_state
       RESTART IDENTITY CASCADE`);
  sql(`UPDATE studio.settings SET digest_time = NULL, reminder_minutes = '{1440,60}'`);
  await quiet();
  await fetch(`${MOCK}/__reset`, { method: 'POST' });
  today = sql('SELECT studio._today()');
  tomorrow = addDays(today, 1);
});

test('the first person becomes admin, everyone after waits to be let in', async () => {
  const home = await dana.say('/start');
  assert.match(home.text, /signed in as an admin/);
  assert.match(home.text, /Flex &amp; Flow &lt;Studio&gt;/, 'studio name is escaped');
  assert.ok(home.button('People'), 'admin sees People');

  const waiting = await anna.say('/start');
  assert.match(waiting.text, /went to the studio admins/);
  assert.equal(waiting.buttons.length, 0);
  assert.match((await anna.say('/book')).text, /went to the studio admins/, 'no access before approval');

  const request = await dana.notification(/Anna.*wants to use the studio bot/s);
  const person = await dana.tap('Review', request);
  assert.match(person.text, /Waiting to be let in/);
  const approved = await dana.tap('Let in as trainer');
  assert.equal(approved.toast, 'Now a trainer');
  assert.match(approved.text, /Trainer/);

  const welcome = await anna.notification(/You are in/);
  const annaHome = await anna.tap('Open the menu', welcome);
  assert.match(annaHome.text, /signed in as a trainer/);
  assert.equal(annaHome.button('People'), undefined, 'trainer does not see People');

  await ben.say('/start');
  await dana.tap('Review', await dana.notification(/Ben &lt;b&gt;&amp;.*wants to use/s));
  await dana.tap('Let in as trainer');
  assert.equal(sql(`SELECT string_agg(role || ':' || status, ',' ORDER BY id) FROM studio.person`), 'admin:active,trainer:active,trainer:active');
});

test('an admin sets up rooms and class types by typing', async () => {
  await dana.say('/rooms');
  await dana.tap('Add a room');
  const rooms = await dana.say('Studio A, 20');
  assert.match(rooms.text, /Studio A · up to 20/);

  await dana.tap('Add a room');
  const duplicate = await dana.say('studio a');
  assert.match(duplicate.text, /already one called/);
  const second = await dana.say('Loft <2> & Deck');
  assert.match(second.text, /Loft &lt;2&gt; &amp; Deck/);

  await dana.say('/classtypes');
  await dana.tap('Add a class type');
  assert.match((await dana.say('Yoga')).text, /could not read that/, 'minutes are required');
  assert.match((await dana.say('Yoga, 60')).text, /Class types/);
  await dana.tap('Add a class type');
  const types = await dana.say('HIIT, 45');
  assert.deepEqual(types.labels.slice(0, 2), ['✅ HIIT · 45 min', '✅ Yoga · 60 min']);

  ids.roomA = Number(sql(`SELECT id FROM studio.room WHERE name = 'Studio A'`));
  ids.loft = Number(sql(`SELECT id FROM studio.room WHERE name LIKE 'Loft%'`));
  ids.yoga = Number(sql(`SELECT id FROM studio.class_type WHERE name = 'Yoga'`));
  ids.hiit = Number(sql(`SELECT id FROM studio.class_type WHERE name = 'HIIT'`));
});

test('a trainer cannot reach admin screens, even with a forged button', async () => {
  for (const data of ['pl', 'ro', 'cl', 'rn', `rt:${ids.roomA}`, 'ps:1:block', 'ps:2:admin']) {
    const refused = await anna.tapData(data);
    assert.match(refused.text, /Not possible/, data);
  }
  assert.equal(sql(`SELECT role || ':' || status FROM studio.person WHERE id = 1`), 'admin:active');
  assert.equal(sql(`SELECT active FROM studio.room WHERE id = ${ids.roomA}`), 't');
});

test('booking: class, room, day, time, confirm', async () => {
  const card = await toConfirm(anna, { klass: 'Yoga', room: 'Studio A', day: tomorrow, time: '09:00' });
  assert.match(card.text, /Book this class\?/);
  assert.match(card.text, /Room: Studio A/);
  assert.match(card.text, /09:00–10:00/);
  assert.equal(card.button('Change trainer'), undefined, 'only admins choose the trainer');

  const seq = await lastSeq();
  const done = await anna.tap('Book it');
  assert.match(done.text, /<b>Booked<\/b>/);
  assert.equal(done.toast, 'Booked');
  assert.equal(count(`room_id = ${ids.roomA} AND status = 'confirmed'`), 1);

  const told = await dana.notification(/Anna booked a class/, { since: seq });
  assert.match(told.text, /Yoga/);
  ids.annaYoga = Number(sql(`SELECT max(id) FROM studio.booking`));
});

test('a taken time, and every start that would overlap it, is no longer offered', async () => {
  await ben.say('/book');
  await ben.tap('Yoga');
  await ben.tap('Studio A');
  const times = await ben.tap(dayName(tomorrow));
  for (const gone of ['08:30', '09:00', '09:30']) assert.ok(!times.labels.includes(gone), `${gone} is hidden`);
  for (const free of ['08:00', '10:00']) assert.ok(times.labels.includes(free), `${free} is offered`);
});

test('two people confirm the same slot at the same moment: one wins, the other is offered the free times', async () => {
  const slot = { klass: 'Yoga', room: 'Loft', day: tomorrow, time: '11:00' };
  await toConfirm(anna, slot);
  await toConfirm(ben, slot);

  const [a, b] = await Promise.all([anna.tap('Book it'), ben.tap('Book it')]);
  const winners = [a, b].filter((s) => /<b>Booked<\/b>/.test(s.text));
  const losers = [a, b].filter((s) => /Just taken/.test(s.text));
  assert.equal(winners.length, 1, 'exactly one booking');
  assert.equal(losers.length, 1, 'the other is told');
  assert.equal(count(`room_id = ${ids.loft} AND status = 'confirmed'`), 1);

  const loser = losers[0] === a ? anna : ben;
  assert.match(loser.screen.text, /was booked for 11:00/);
  assert.ok(!loser.screen.labels.includes('11:00'));
  assert.ok(loser.screen.labels.includes('12:00'), 'free times of the same room and day are offered at once');

  // No starting over: the loser taps another time and lands on the confirmation card.
  const retry = await loser.tap('12:00');
  assert.match(retry.text, /Book this class\?/);
  assert.match(retry.text, /12:00–13:00/);
  assert.match((await loser.tap('Book it')).text, /<b>Booked<\/b>/);
  assert.equal(count(`room_id = ${ids.loft} AND status = 'confirmed'`), 2);
});

test('a trainer cannot be booked into two rooms at once', async () => {
  await anna.say('/book');
  await anna.tap('HIIT');
  await anna.tap('Loft');
  const times = await anna.tap(dayName(tomorrow));
  assert.ok(!times.labels.includes('09:00'), 'her Yoga hour in Studio A hides 09:00 in the Loft');
  assert.match(times.text, /hidden because you teach somewhere else/);

  // Even a forged confirm button is stopped by the database.
  const forced = await anna.tapData(`B:c${ids.hiit}:r${ids.loft}:d${packDay(tomorrow)}:t0900`);
  assert.match(forced.text, /Just taken/);
  assert.match(forced.text, /You are already teaching/);
});

test('tapping "Book it" twice books once', async () => {
  const data = `B:c${ids.hiit}:r${ids.roomA}:d${packDay(tomorrow)}:t1500`;
  const [first, second] = await Promise.all([ben.tapData(data), ben.tapData(data)]);
  assert.match(first.text + second.text, /<b>Booked<\/b>/);
  assert.doesNotMatch(first.text + second.text, /Just taken/);
  assert.equal(count(`room_id = ${ids.roomA} AND trainer_id = 3 AND status = 'confirmed'`), 1);
});

test('moving a class releases the old time and takes the new one in one step', async () => {
  const list = await anna.say('/my');
  assert.match(list.text, /upcoming/);
  await anna.tap(`${dayName(tomorrow)} 09:00`);
  await anna.tap('Move');
  await anna.tap(dayName(addDays(today, 2)));
  const confirm = await anna.tap('10:00');
  assert.match(confirm.text, /Move this class\?/);
  assert.match(confirm.text, /From: .*09:00–10:00 · Studio A/);
  assert.match(confirm.text, /To: .*10:00–11:00 · Studio A/);

  const seq = await lastSeq();
  const moved = await anna.tap('Move it');
  assert.match(moved.text, /<b>Moved<\/b>/);
  assert.equal(sql(`SELECT studio._day(lower(during)) || ' ' || studio._hhmm(lower(during)) FROM studio.booking WHERE id = ${ids.annaYoga}`), `${addDays(today, 2)} 10:00`);
  assert.equal(count(`id = ${ids.annaYoga}`), 1, 'still one row: it moved, it was not copied');
  await dana.notification(/Anna moved a class/, { since: seq });

  const day = await ben.tapData(`s:${packDay(tomorrow)}`);
  assert.doesNotMatch(day.text, /09:00–10:00 {2}Yoga/, 'the old time is free again');

  // Into a taken slot: refused, and the class stays where it was.
  const clash = await anna.tapData(`E:${ids.annaYoga}:r${ids.roomA}:d${packDay(tomorrow)}:t1500`);
  assert.match(clash.text, /Just taken/);
  assert.equal(sql(`SELECT studio._hhmm(lower(during)) FROM studio.booking WHERE id = ${ids.annaYoga}`), '10:00');
});

test("a trainer cannot move or cancel someone else's class; an admin can", async () => {
  const view = await ben.tapData(`v:${ids.annaYoga}`);
  assert.match(view.text, /Trainer: Anna/);
  assert.equal(view.button('Move'), undefined);
  assert.equal(view.button('Cancel class'), undefined);
  assert.match((await ben.tapData(`X:${ids.annaYoga}`)).text, /Not possible/);
  assert.match((await ben.tapData(`E:${ids.annaYoga}:d${packDay(tomorrow)}:t1700`)).text, /Not possible/);
  assert.equal(count(`id = ${ids.annaYoga} AND status = 'confirmed'`), 1);

  await dana.tapData(`s:${packDay(addDays(today, 2))}`);
  await dana.tap('Open a class');
  const asAdmin = await dana.tap('10:00 Yoga');
  assert.ok(asAdmin.button('Cancel class'));
  await dana.tap('Cancel class');
  const seq = await lastSeq();
  const cancelled = await dana.tap('Yes, cancel it');
  assert.match(cancelled.text, /<b>Cancelled<\/b>/);
  assert.match((await anna.notification(/Dana cancelled your class/, { since: seq })).text, /Yoga/);

  // The slot is free again for anyone.
  await ben.say('/book');
  await ben.tap('Yoga');
  await ben.tap('Studio A');
  assert.ok((await ben.tap(dayName(addDays(today, 2)))).labels.includes('10:00'));
});

test('weekly series: books every free week, reports the ones it could not', async () => {
  // Anna already holds the Loft at 18:00 two weeks from tomorrow.
  const blockedDay = addDays(tomorrow, 14);
  assert.match((await anna.tapData(`B:c${ids.yoga}:r${ids.loft}:d${packDay(blockedDay)}:t1800`)).text, /<b>Booked<\/b>/);

  await toConfirm(ben, { klass: 'HIIT', room: 'Loft', day: tomorrow, time: '18:00' });
  const series = await ben.tap('Weekly × 4');
  assert.match(series.text, /Booked 3 of 4 weekly classes/);
  assert.match(series.text, new RegExp(`${dayName(blockedDay)}: room already booked`));
  assert.equal(count(`trainer_id = 3 AND room_id = ${ids.loft} AND series_id IS NOT NULL AND status = 'confirmed'`), 3);

  const first = await ben.tap('Open class');
  assert.match(first.text, /weekly series: 2 more after this one/);
  await ben.tap('Cancel class');
  const gone = await ben.tap('Cancel it and the 2 after it');
  assert.match(gone.text, /Cancelled 3 classes/);
  assert.equal(count(`trainer_id = 3 AND series_id IS NOT NULL AND status = 'confirmed'`), 0);
});

test('an admin books a class for a trainer, who is told', async () => {
  const card = await toConfirm(dana, { klass: 'Yoga', room: 'Studio A', day: tomorrow, time: '07:00' });
  assert.match(card.text, /Trainer: Dana/);
  await dana.tap('Change trainer');
  const forAnna = await dana.tap('Anna');
  assert.match(forAnna.text, /Trainer: Anna/);
  const seq = await lastSeq();
  await dana.tap('Book it');
  const told = await anna.notification(/Dana booked you for a class/, { since: seq });
  assert.ok(told.button('Open class'));
  assert.equal(count(`trainer_id = 2 AND created_by = 1 AND status = 'confirmed'`), 1);
});

test('the schedule lists classes and the free windows of every room', async () => {
  const day = await dana.tapData(`s:${packDay(tomorrow)}`);
  assert.match(day.text, /<b>Studio A<\/b> · up to 20/);
  assert.match(day.text, /07:00–08:00 {2}Yoga · Anna/);
  assert.match(day.text, /15:00–15:45 {2}HIIT · Ben &lt;b&gt;&amp;/);
  assert.match(day.text, /Free: 06:00–07:00, 08:00–15:00, 15:45–22:00/);
  assert.match(day.text, /<b>Loft &lt;2&gt; &amp; Deck<\/b>/);
  assert.ok(day.button(`Book on ${dayName(tomorrow)}`));

  // Booking from the schedule keeps the day: after class and room comes the time.
  await dana.tap(`Book on ${dayName(tomorrow)}`);
  await dana.tap('HIIT');
  const times = await dana.tap('Studio A');
  assert.match(times.text, /Pick a start time/);
  assert.ok(times.labels.includes('08:00') && !times.labels.includes('07:00'));
});

test('a tap that changes nothing, or lands on a message that is gone, is not an error', async () => {
  const shown = await dana.tapData(`s:${packDay(tomorrow)}`);
  const same = await dana.tapData(`s:${packDay(tomorrow)}`, shown.message_id);
  assert.equal(same.ok, false, 'Telegram refuses an edit that changes nothing');

  const resent = await anna.tapData('m', 424242);
  assert.equal(resent.method, 'sendMessage', 'the reply arrives as a new message instead');
  assert.match(resent.text, /My classes/);
});

test('reminders go out once, and not for a class that was booked inside the window', async () => {
  // Starts in 50 minutes and was scheduled hours ago: the 1-hour reminder is due.
  sql(`INSERT INTO studio.booking (room_id, trainer_id, class_type_id, during, created_by, scheduled_at)
       VALUES (${ids.loft}, 2, ${ids.yoga}, tstzrange(now() + interval '50 minutes', now() + interval '110 minutes'), 2, now() - interval '5 hours')`);
  // Starts in 55 minutes but was booked just now: no reminder.
  sql(`INSERT INTO studio.booking (room_id, trainer_id, class_type_id, during, created_by)
       VALUES (${ids.roomA}, 3, ${ids.hiit}, tstzrange(now() + interval '55 minutes', now() + interval '100 minutes'), 3)`);

  const reminder = await anna.notification(/<b>Reminder<\/b> · In 1 hour/);
  assert.match(reminder.text, /Yoga/);
  await sleep(12_000); // two more notifier runs
  const { calls } = await mockState();
  const reminders = calls.filter((c) => c.method === 'sendMessage' && /<b>Reminder<\/b>/.test(c.body.text));
  assert.equal(reminders.length, 1, 'sent once, and only to Anna');
});

test('the morning summary lists the classes of the day', async () => {
  // Only meaningful when the class from the previous test is still "today" in the studio's time zone.
  const teachesToday = sql(`SELECT count(*) FROM studio.booking WHERE trainer_id = 2 AND status = 'confirmed'
                            AND lower(during) > now() AND studio._day(lower(during)) = studio._today()::text`);
  sql(`UPDATE studio.settings SET digest_time = (now() AT TIME ZONE timezone)::time - interval '1 minute'`);
  try {
    if (teachesToday !== '0') {
      const digest = await anna.notification(/Your classes today/);
      assert.match(digest.text, /Yoga · Loft/);
    }
    await sleep(6000); // another notifier run must not send it again
    assert.equal(sql(`SELECT count(*) FROM studio.outbox WHERE kind = 'digest' AND person_id = 2`), teachesToday === '0' ? '0' : '1');
  } finally {
    sql(`UPDATE studio.settings SET digest_time = NULL`);
  }
});

test('the calendar feed serves the schedule to calendar apps, with a secret link', async () => {
  const links = await anna.say('/calendar');
  const url = links.text.match(/Your classes:\n<code>([^<]+)<\/code>/)[1].replace(/&amp;/g, '&');
  const feed = await fetch(url);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /text\/calendar/);
  const body = await feed.text();
  assert.match(body, /^BEGIN:VCALENDAR\r\n/);
  assert.match(body, /SUMMARY:Yoga - Anna\r\n/);
  assert.match(body, /LOCATION:Studio A\r\n/);
  assert.doesNotMatch(body, /HIIT/, "only Anna's classes are in her feed");
  assert.match(body, /END:VCALENDAR\r\n$/);

  const studio = await (await fetch(url.replace(/&trainer=\d+/, ''))).text();
  assert.match(studio, /SUMMARY:HIIT - Ben <b>&\r\n/);
  assert.match(studio, /LOCATION:Loft <2> & Deck\r\n/);

  assert.equal((await fetch(url.replace(/token=[0-9a-f]+/, 'token=wrong'))).status, 404);
  assert.equal((await fetch(url.replace(/trainer=\d+/, 'trainer=1;DROP'))).status, 404);
});

test('a repeated update is handled once and group chats are ignored', async () => {
  const update = anna.messageUpdate('/start');
  const before = await lastSeq();
  await post(update);
  await post(update);
  await quiet(1500);
  const replies = (await mockState()).calls.slice(before).filter((c) => c.method === 'sendMessage');
  assert.equal(replies.length, 1);

  const inGroup = anna.messageUpdate('/start');
  inGroup.message.chat = { id: -500, type: 'group', title: 'Trainers' };
  const seq = await lastSeq();
  await post(inGroup);
  await quiet(1500);
  assert.equal((await mockState()).calls.length, seq);
});

test('blocking removes access at once; the last admin cannot be removed', async () => {
  await dana.say('/people');
  await dana.tap('Ben');
  const blocked = await dana.tap('Block');
  assert.equal(blocked.toast, 'Blocked');
  assert.match((await ben.say('/book')).text, /switched off/);
  assert.match((await ben.tapData(`B:c${ids.yoga}:r${ids.roomA}:d${packDay(tomorrow)}:t2000`)).text, /switched off/);
  assert.ok(count(`trainer_id = 3 AND status = 'confirmed' AND lower(during) > now()`) > 0, 'his classes stay for an admin to reassign or cancel');

  await dana.tapData('pv:1');
  const refused = await dana.tap('Make trainer');
  assert.match(refused.text, /needs at least one admin/);
  assert.equal(sql(`SELECT role FROM studio.person WHERE id = 1`), 'admin');
});

test('a message to someone who blocked the bot is marked failed, not retried forever', async () => {
  await carol.say('/start');
  await fetch(`${MOCK}/__block`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: carol.id }) });
  await dana.tap('Review', await dana.notification(/Carol.*wants to use/s));
  await dana.tap('Let in as trainer');
  await quiet(1500);
  const row = sql(`SELECT (failed_at IS NOT NULL) || '|' || last_error FROM studio.outbox WHERE kind = 'access_granted' AND person_id = 4`);
  assert.equal(row, 'true|Forbidden: bot was blocked by the user');
});

test('a failing run alerts the admins through the error workflow', async () => {
  const seq = await lastSeq();
  sql(`ALTER FUNCTION studio.calendar(jsonb) RENAME TO calendar_broken`);
  try {
    await post(anna.messageUpdate('/calendar'));
    const alert = await dana.notification(/The studio bot hit an error/, { since: seq, timeoutMs: 40_000 });
    assert.match(alert.text, /Workflow: Studio Bot · 1 Chat/);
    assert.match(alert.text, /Step: Calendar links/);
  } finally {
    sql(`ALTER FUNCTION studio.calendar_broken(jsonb) RENAME TO calendar`);
  }
  assert.match((await anna.say('/calendar')).text, /Calendar feed/);
});

test('no run failed apart from the one broken on purpose, and Telegram refused nothing unexpected', async () => {
  await quiet(1500);
  assert.equal(sql(`SELECT count(*) FROM execution_entity WHERE status NOT IN ('success', 'running', 'new', 'waiting')`), '1');
  const { calls } = await mockState();
  const refusals = calls
    .filter((c) => !c.response.ok)
    .map((c) => c.response.description)
    .filter((why) => !/not modified|message to edit not found|blocked by the user/.test(why));
  assert.deepEqual(refusals, []);
});
