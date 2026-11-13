// The "Route" Code node: turn one Telegram update into the name of a branch,
// the screen to draw and the request for that branch's database function.
// It decides where to go, never whether it is allowed: Postgres checks that.

const COMMANDS = {
  start: 'h',
  menu: 'h',
  help: 'help',
  schedule: 's',
  today: 's',
  book: 'b',
  my: 'm',
  calendar: 'cal',
  people: 'pl',
  rooms: 'ro',
  classtypes: 'cl',
};

function route(update, begin) {
  if (!begin || begin.skip) return null;
  const tap = update.callback_query;
  const message = tap ? tap.message : update.message;
  if (!message || !message.chat) return null;

  const me = begin.me;
  const reply = {
    chat_id: message.chat.id,
    message_id: tap ? message.message_id : null,
    callback_id: tap ? tap.id : null,
  };
  const go = (branch, screen, req = {}, extra = {}) => ({
    branch,
    screen,
    req: { tg: me.tg, ...req },
    reply,
    ...extra,
  });

  if (me.status !== 'active') return go('home', me.status);

  let action;
  if (tap) {
    action = String(tap.data || 'h');
  } else {
    const text = String(message.text || '').trim();
    if (text.startsWith('/')) {
      action = COMMANDS[text.slice(1).split(/[\s@]/)[0].toLowerCase()] || 'unknown';
    } else if (begin.awaiting && text) {
      return go('manage', 'manage', { op: 'input', text: text.slice(0, 200) });
    } else {
      return go('home', 'home', {}, { hint: 'unknown' });
    }
  }

  const parts = action.split(':');
  const head = parts[0];
  const id = (index) => (/^\d{1,15}$/.test(parts[index] || '') ? Number(parts[index]) : null);

  switch (head) {
    case 'h':
      return go('home', 'home');
    case 'help':
      return go('home', 'help');

    case 's': {
      const day = unpackDay(parts[1]);
      return go('schedule', parts[2] === 'm' ? 'day_classes' : 'schedule', day ? { day } : {});
    }

    // Booking: "b:..." shows the next question, "B:..." commits.
    case 'b':
    case 'B': {
      const steps = readSteps(parts.slice(1));
      const wiz = { base: 'b', steps };
      const req = {};
      if (steps.c) req.class = Number(steps.c);
      if (steps.r && steps.r !== '0') req.room = Number(steps.r);
      if (steps.d) req.day = unpackDay(steps.d);
      if (steps.t) req.time = unpackTime(steps.t);
      if (steps.p && steps.p !== '0') req.trainer = Number(steps.p);
      if (steps.w) req.week = Number(steps.w);
      const complete = req.class && req.room && req.day && req.time;
      if (head === 'B' && complete) {
        return go('book', 'booked', { ...req, repeat: steps.n ? Number(steps.n) : 1 }, { wiz });
      }
      if (steps.p === '0') return go('options', 'book_trainer', req, { wiz });
      if (!req.class) return go('options', 'book_class', req, { wiz });
      if (!req.room) return go('options', 'book_room', req, { wiz });
      if (!req.day) return go('days', 'book_day', req, { wiz });
      if (!req.time) return go('slots', 'book_time', req, { wiz });
      return go('preview', 'book_confirm', req, { wiz });
    }

    // Moving a class: "e:<id>:..." asks, "E:<id>:..." commits.
    case 'e':
    case 'E': {
      const booking = id(1);
      if (!booking) return go('home', 'home', {}, { hint: 'unknown' });
      const steps = without(readSteps(parts.slice(2)), 'c', 'p', 'n');
      const wiz = { base: `e:${booking}`, steps };
      const req = { booking };
      if (steps.r && steps.r !== '0') req.room = Number(steps.r);
      if (steps.d) req.day = unpackDay(steps.d);
      if (steps.t) req.time = unpackTime(steps.t);
      if (steps.w) req.week = Number(steps.w);
      if (head === 'E' && req.day && req.time) return go('reschedule', 'moved', req, { wiz });
      if (steps.r === '0') return go('options', 'move_room', { booking }, { wiz });
      if (!req.day) return go('days', 'move_day', req, { wiz });
      if (!req.time) return go('slots', 'move_time', req, { wiz });
      return go('preview', 'move_confirm', req, { wiz });
    }

    case 'm':
      return go('bookings', 'mine', { page: id(1) || 0 });
    case 'v':
      return id(1) ? go('booking', 'view', { id: id(1) }) : go('home', 'home');
    case 'x':
      return id(1) ? go('booking', 'cancel_confirm', { id: id(1) }) : go('home', 'home');
    case 'X':
      return id(1)
        ? go('cancel', 'cancelled', { id: id(1), following: parts[2] === 'f' })
        : go('home', 'home');

    case 'pl':
      return go('people', 'people', { op: 'list' });
    case 'pv':
      return go('people', 'person', { op: 'view', id: id(1) });
    case 'ps':
      return go('people', 'person', { op: 'set', id: id(1), action: parts[2] });

    case 'ro':
      return go('manage', 'manage', { op: 'rooms' });
    case 'rt':
      return go('manage', 'manage', { op: 'room_toggle', id: id(1) });
    case 'rn':
      return go('manage', 'ask', { op: 'ask', awaiting: 'room_new' });
    case 'rr':
      return go('manage', 'ask', { op: 'ask', awaiting: 'room_rename', id: id(1) });
    case 'cl':
      return go('manage', 'manage', { op: 'classes' });
    case 'ct':
      return go('manage', 'manage', { op: 'class_toggle', id: id(1) });
    case 'cn':
      return go('manage', 'ask', { op: 'ask', awaiting: 'class_new' });

    case 'cal':
      return go('calendar', 'calendar');
    default:
      return go('home', 'home', {}, { hint: 'unknown' });
  }
}

// --- exports for the unit tests (scripts/build.mjs drops everything below) ---
Object.assign(module.exports, { route, COMMANDS });
