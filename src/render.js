// The "Render" Code node: turn the routed request and the database answer
// into Telegram API calls. Every word the bot says is in this file (and in
// notify.js), so this is the place to translate or reword.
//
// A screen returns { text, rows, toast }. Taps edit the message they came
// from, so a whole booking happens in one message instead of a long scroll.

const MENU = [button('Menu', 'h')];

const REFUSALS = {
  forbidden: 'That is not available for your role.',
  not_found: 'That item no longer exists.',
  closed: 'That class has started, finished or been cancelled, so it can no longer be changed.',
  class_gone: 'That class type is no longer offered.',
  room_gone: 'That room is no longer available. Pick another room.',
  trainer_gone: 'That trainer no longer has access.',
  bad_slot: 'That start time can no longer be booked.',
  last_admin: 'The studio needs at least one admin. Make someone else an admin first.',
  no_calendar: 'The calendar feed is not switched on for this studio.',
};

const span = (b) => `${b.from}–${b.to}`;

// The card that describes one class, used on every screen that shows one.
function card(b, today) {
  return [
    `<b>${esc(b.class)}</b> · ${b.minutes} min`,
    `Room: ${esc(b.room)}`,
    `When: ${dayLabel(b.day, today)}, ${span(b)}`,
    `Trainer: ${esc(b.trainer)}`,
  ].join('\n');
}

function planCard(d, today) {
  return card(
    {
      class: d.plan.class.name,
      minutes: d.plan.minutes,
      room: d.plan.room.name,
      trainer: d.plan.trainer.name,
      day: d.day,
      from: d.from,
      to: d.to,
    },
    today,
  );
}

// The lines above a question in the booking and moving flows.
function planHead(plan) {
  const lines = [`${esc(plan.class.name)} · ${plan.minutes} min`];
  if (plan.room) lines.push(`Room: ${esc(plan.room.name)}`);
  if (!plan.trainer.self) lines.push(`Trainer: ${esc(plan.trainer.name)}`);
  return lines.join('\n');
}

function dayButtons(ctx, d, backData) {
  const { base, steps } = ctx.wiz;
  const open = d.days.filter((day) => day.free > 0);
  const rows = rowsOf(
    open.map((day) =>
      button(
        `${dayName(day.day)} · ${day.free} free`,
        wizard(base, { ...without(steps, 'w', 't'), d: packDay(day.day) }),
      ),
    ),
    2,
  );
  const paging = [];
  if (d.week > 0) paging.push(button('‹ Earlier', wizard(base, { ...without(steps, 'd', 't'), w: d.week - 1 })));
  if (d.more) paging.push(button('Later ›', wizard(base, { ...without(steps, 'd', 't'), w: d.week + 1 })));
  if (paging.length) rows.push(paging);
  const full = d.days.filter((day) => day.free === 0).map((day) => dayName(day.day));
  return { rows, full, any: open.length > 0, backData };
}

function timeButtons(ctx, slots) {
  const { base, steps } = ctx.wiz;
  return rowsOf(
    slots.map((time) => button(time, wizard(base, { ...without(steps, 'n', 'w'), t: packTime(time) }))),
    4,
  );
}

// Somebody else got there first. The choices made so far are still in the
// button data, so the same room and day are offered again with fresh times.
function taken(ctx, d) {
  const { base, steps } = ctx.wiz;
  const when = `${d.time} on ${dayName(d.day)}`;
  const reason =
    d.why === 'trainer'
      ? `${esc(d.plan.trainer.self ? 'You are' : `${d.plan.trainer.name} is`)} already teaching at ${when}.`
      : `${esc(d.plan.room.name)} was booked for ${when} a moment ago.`;
  const rows = timeButtons(ctx, d.slots);
  rows.push([button('Another day', wizard(base, without(steps, 'd', 't', 'n', 'w')))]);
  rows.push(base === 'b' ? [button('✖ Cancel', 'h')] : [button('✖ Keep as is', `v:${d.plan.booking.id}`)]);
  return {
    text: [
      '<b>Just taken</b>',
      reason,
      '',
      d.slots.length ? 'These start times are still free that day:' : 'Nothing else is free that day.',
    ].join('\n'),
    rows,
    toast: 'That time was just taken',
  };
}

const SCREENS = {
  home(ctx) {
    const { me, studio } = ctx.begin;
    const admin = me.role === 'admin';
    const lines = [];
    if (ctx.route.hint === 'unknown') lines.push('I did not understand that. Use the buttons below.', '');
    lines.push(`<b>${esc(studio.name)}</b>`);
    lines.push(`Hi ${esc(me.name)}. You are signed in as ${admin ? 'an admin' : 'a trainer'}.`);
    if (me.is_new && admin) {
      lines.push('', 'You are the first person here, so you are the admin. Everyone who starts this bot after you waits for your approval.');
    }
    const missing = [studio.rooms === 0 && 'a room', studio.classes === 0 && 'a class type'].filter(Boolean);
    if (missing.length) {
      lines.push('', admin
        ? `Before anyone can book, add ${missing.join(' and ')} with the buttons below.`
        : 'The studio is not ready for bookings yet: an admin still has to add rooms and class types.');
    }
    const rows = [
      [button('📅 Schedule', 's'), button('➕ Book a class', 'b')],
      [button('🗂 My classes', 'm')].concat(studio.calendar ? [button('🔗 Calendar', 'cal')] : []),
    ];
    if (admin) rows.push([button('👥 People', 'pl'), button('🚪 Rooms', 'ro'), button('🏷 Class types', 'cl')]);
    return { text: lines.join('\n'), rows };
  },

  help(ctx) {
    const admin = ctx.begin.me.role === 'admin';
    const lines = [
      '<b>What this bot does</b>',
      '/schedule shows every room for a day, with the free times',
      '/book books a room for a class, once or weekly',
      '/my lists your upcoming classes, to move or cancel them',
      '/calendar gives links for Google, Apple or Outlook calendars',
      '',
      'A room is never booked twice and you are never booked in two rooms at once. You get a reminder before each class.',
    ];
    if (admin) {
      lines.push('', '<b>Admins</b>', '/people lets people in and sets their role', '/rooms and /classtypes set up the studio', 'Admins can book for any trainer and move or cancel any class.');
    } else {
      lines.push('', 'Trainers can move and cancel their own classes. Admins can change any class.');
    }
    return { text: lines.join('\n'), rows: [MENU] };
  },

  pending(ctx) {
    return {
      text: `Thanks, ${esc(ctx.begin.me.name)}. Your request to use this bot went to the studio admins. You will get a message here as soon as one of them lets you in.`,
      rows: [],
    };
  },

  blocked() {
    return { text: 'Your access to this bot is switched off. Ask a studio admin if that is a mistake.', rows: [] };
  },

  schedule(ctx, d) {
    const admin = ctx.begin.me.role === 'admin';
    const lines = [`<b>${dayLabel(d.day, ctx.today)}</b>`];
    lines.push(d.closed ? 'The studio is closed on this day.' : `Open ${d.opens}–${d.closes}`);
    if (!d.rooms.length) lines.push('', admin ? 'There are no rooms yet. Add one under Rooms in the menu.' : 'There are no rooms yet.');
    let classes = 0;
    for (const room of d.rooms) {
      lines.push('', `<b>${esc(room.name)}</b>${room.capacity ? ` · up to ${room.capacity}` : ''}`);
      for (const c of room.classes) {
        classes += 1;
        lines.push(`${span(c)}  ${esc(c.class)} · ${c.mine ? 'you' : esc(c.trainer)}`);
      }
      if (!room.classes.length) lines.push('No classes');
      if (!d.past && !d.closed) {
        lines.push(room.free.length ? `Free: ${room.free.map(span).join(', ')}` : 'Free: nothing left');
      }
    }
    const rows = [[button(`‹ ${dayName(addDays(d.day, -1))}`, `s:${packDay(addDays(d.day, -1))}`)]];
    if (d.day !== ctx.today) rows[0].push(button('Today', 's'));
    rows[0].push(button(`${dayName(addDays(d.day, 1))} ›`, `s:${packDay(addDays(d.day, 1))}`));
    if (d.bookable && d.rooms.length) rows.push([button(`➕ Book on ${dayName(d.day)}`, `b:d${packDay(d.day)}`)]);
    if (classes) rows.push([button('Open a class', `s:${packDay(d.day)}:m`)]);
    rows.push(MENU);
    return { text: lines.join('\n'), rows };
  },

  day_classes(ctx, d) {
    const items = d.rooms.flatMap((room) => room.classes).sort((a, b) => a.from.localeCompare(b.from));
    const rows = items.slice(0, 40).map((c) => [
      button(`${c.from} ${c.class} · ${c.room} · ${c.mine ? 'you' : c.trainer}`.slice(0, 60), `v:${c.id}`),
    ]);
    rows.push([button('‹ Back', `s:${packDay(d.day)}`)]);
    return {
      text: `<b>${dayLabel(d.day, ctx.today)}</b>\n${items.length ? 'Which class do you want to open?' : 'No classes on this day.'}`,
      rows,
    };
  },

  book_class(ctx, d) {
    const { steps } = ctx.wiz;
    const day = steps.d ? unpackDay(steps.d) : null;
    const lines = [`<b>New class</b>${day ? ` on ${dayLabel(day, ctx.today)}` : ''}`];
    if (!d.classes.length || !d.rooms.length) {
      lines.push('', ctx.begin.me.role === 'admin'
        ? 'Add at least one room and one class type first, from the menu.'
        : 'The studio is not ready for bookings yet: an admin still has to add rooms and class types.');
      return { text: lines.join('\n'), rows: [MENU] };
    }
    lines.push('', 'What are you teaching?');
    const rows = rowsOf(
      d.classes.map((c) => button(`${c.name} · ${c.minutes} min`, wizard('b', { ...steps, c: c.id }))),
      2,
    );
    rows.push([button('✖ Cancel', 'h')]);
    return { text: lines.join('\n'), rows };
  },

  book_room(ctx, d) {
    const { steps } = ctx.wiz;
    const chosen = d.classes.find((c) => String(c.id) === steps.c);
    if (!chosen) return refusal({ error: 'class_gone' });
    const rows = rowsOf(
      d.rooms.map((room) =>
        button(`${room.name}${room.capacity ? ` (${room.capacity})` : ''}`, wizard('b', { ...steps, r: room.id })),
      ),
      2,
    );
    rows.push([button('‹ Back', wizard('b', without(steps, 'c'))), button('✖ Cancel', 'h')]);
    return {
      text: `<b>New class</b>\n${esc(chosen.name)} · ${chosen.minutes} min\n\nWhich room?`,
      rows,
    };
  },

  book_trainer(ctx, d) {
    const { steps } = ctx.wiz;
    const rows = rowsOf(
      d.trainers.map((t) => button(t.self ? `${t.name} (you)` : t.name, wizard('b', { ...steps, p: t.id }))),
      2,
    );
    rows.push([button('‹ Back', wizard('b', without(steps, 'p')))]);
    return { text: '<b>New class</b>\n\nWho teaches it?', rows };
  },

  book_day(ctx, d) {
    const { steps } = ctx.wiz;
    const days = dayButtons(ctx, d);
    const lines = ['<b>New class</b>', planHead(d.plan), ''];
    lines.push(days.any ? 'Which day?' : 'No free start times in these days.');
    if (days.full.length && days.any) lines.push(`Full or closed: ${days.full.join(', ')}`);
    days.rows.push([button('‹ Back', wizard('b', without(steps, 'r', 'd', 't', 'w'))), button('✖ Cancel', 'h')]);
    return { text: lines.join('\n'), rows: days.rows };
  },

  book_time(ctx, d) {
    const { steps } = ctx.wiz;
    const lines = ['<b>New class</b>', planHead(d.plan), `Day: ${dayLabel(d.day, ctx.today)}`, ''];
    lines.push(d.slots.length ? 'Pick a start time.' : 'No free start times on this day.');
    if (d.trainer_busy > 0) {
      lines.push(`${d.trainer_busy} more are hidden because ${d.plan.trainer.self ? 'you teach' : `${esc(d.plan.trainer.name)} teaches`} somewhere else then.`);
    }
    const rows = timeButtons(ctx, d.slots);
    rows.push([button('‹ Back', wizard('b', without(steps, 'd', 't'))), button('✖ Cancel', 'h')]);
    return { text: lines.join('\n'), rows };
  },

  book_confirm(ctx, d) {
    const { steps } = ctx.wiz;
    const back = button('‹ Back', wizard('b', without(steps, 't', 'n')));
    if (!d.free) {
      return {
        text: `<b>That time is no longer free</b>\n${d.why === 'trainer' ? 'The trainer is teaching somewhere else then.' : 'The room has been booked.'}\n\n${planCard(d, ctx.today)}`,
        rows: [[button('Pick another time', wizard('b', without(steps, 't', 'n')))], [button('✖ Cancel', 'h')]],
      };
    }
    const commit = (weeks) => wizard('B', weeks ? { ...steps, n: weeks } : without(steps, 'n'));
    const rows = [
      [button('✅ Book it', commit(0))],
      [button('Weekly × 4', commit(4)), button('× 8', commit(8)), button('× 12', commit(12))],
    ];
    if (d.is_admin) rows.push([button('👤 Change trainer', wizard('b', { ...steps, p: '0' }))]);
    rows.push([back, button('✖ Cancel', 'h')]);
    return {
      text: `<b>Book this class?</b>\n\n${planCard(d, ctx.today)}\n\nBook it once, or the same time every week.`,
      rows,
    };
  },

  booked(ctx, d) {
    if (d.ok === false) return taken(ctx, d);
    const first = d.booked[0];
    const rows = [
      [button('Open class', `v:${first.id}`), button('➕ Book another', 'b')],
      [button('📅 That day', `s:${packDay(first.day)}`), button('Menu', 'h')],
    ];
    if (d.weeks === 1) return { text: `<b>Booked</b>\n\n${card(first, ctx.today)}`, rows, toast: 'Booked' };
    const reasons = { room: 'room already booked', trainer: 'trainer teaching elsewhere', closed: 'studio closed' };
    const lines = [
      `<b>Booked ${d.booked.length} of ${d.weeks} weekly classes</b>`,
      '',
      `<b>${esc(first.class)}</b> · ${first.minutes} min`,
      `Room: ${esc(first.room)}`,
      `Time: ${span(first)}`,
      `Trainer: ${esc(first.trainer)}`,
      '',
      `Booked: ${d.booked.map((b) => dayName(b.day)).join(', ')}`,
    ];
    if (d.skipped.length) {
      lines.push('', 'Not booked:');
      for (const skip of d.skipped) lines.push(`${dayName(skip.day)}: ${reasons[skip.why] || skip.why}`);
    }
    return { text: lines.join('\n'), rows, toast: `Booked ${d.booked.length} classes` };
  },

  mine(ctx, d) {
    const lines = ['<b>My classes</b>'];
    lines.push(d.total ? `${d.total} upcoming. Open one to move or cancel it.` : 'You have no upcoming classes.');
    const rows = d.items.map((b) => [
      button(`${dayName(b.day)} ${b.from} · ${b.class} · ${b.room}`.slice(0, 60), `v:${b.id}`),
    ]);
    const paging = [];
    if (d.page > 0) paging.push(button('‹ Earlier', `m:${d.page - 1}`));
    if (d.more) paging.push(button('Later ›', `m:${d.page + 1}`));
    if (paging.length) rows.push(paging);
    rows.push([button('➕ Book a class', 'b'), button('Menu', 'h')]);
    return { text: lines.join('\n'), rows };
  },

  view(ctx, d) {
    const b = d.booking;
    const lines = [card(b, ctx.today)];
    if (b.status === 'cancelled') lines.push('', 'This class was cancelled.');
    else if (!b.upcoming) lines.push('', 'This class has started or finished.');
    else if (b.following > 0) lines.push('', `Part of a weekly series: ${b.following} more after this one.`);
    const rows = [];
    if (b.can_edit) rows.push([button('🕑 Move', `e:${b.id}`), button('🗑 Cancel class', `x:${b.id}`)]);
    rows.push([button('📅 That day', `s:${packDay(b.day)}`), button('🗂 My classes', 'm')]);
    rows.push(MENU);
    return { text: lines.join('\n'), rows };
  },

  cancel_confirm(ctx, d) {
    const b = d.booking;
    if (!b.can_edit) return SCREENS.view(ctx, d);
    const rows = [[button('Yes, cancel it', `X:${b.id}`)]];
    if (b.following > 0) rows.push([button(`Cancel it and the ${b.following} after it`, `X:${b.id}:f`)]);
    rows.push([button('‹ Keep it', `v:${b.id}`)]);
    return { text: `<b>Cancel this class?</b>\n\n${card(b, ctx.today)}`, rows };
  },

  cancelled(ctx, d) {
    const b = d.booking;
    const title = d.already
      ? 'This class was already cancelled'
      : d.count > 1
        ? `Cancelled ${d.count} classes, starting with`
        : 'Cancelled';
    return {
      text: `<b>${title}</b>\n\n${card(b, ctx.today)}`,
      rows: [[button('📅 That day', `s:${packDay(b.day)}`), button('🗂 My classes', 'm')], MENU],
      toast: d.already ? 'Already cancelled' : 'Cancelled',
    };
  },

  move_room(ctx, d) {
    const { base, steps } = ctx.wiz;
    const b = d.plan.booking;
    const rows = rowsOf(
      d.rooms.map((room) =>
        button(
          `${room.name}${room.id === b.room_id ? ' (now)' : ''}`,
          wizard(base, { ...without(steps, 'd', 't', 'w'), r: room.id }),
        ),
      ),
      2,
    );
    rows.push([button('‹ Back', wizard(base, without(steps, 'r')))]);
    return { text: `<b>Move class</b>\n${card(b, ctx.today)}\n\nWhich room?`, rows };
  },

  move_day(ctx, d) {
    const { base, steps } = ctx.wiz;
    const b = d.plan.booking;
    const days = dayButtons(ctx, d);
    const lines = ['<b>Move class</b>', card(b, ctx.today), ''];
    if (d.plan.room.id !== b.room_id) lines.push(`New room: ${esc(d.plan.room.name)}`);
    lines.push(days.any ? 'Which day?' : 'No free start times in these days.');
    if (days.full.length && days.any) lines.push(`Full or closed: ${days.full.join(', ')}`);
    days.rows.push([button('🚪 Change room', wizard(base, { ...without(steps, 'd', 't', 'w'), r: '0' }))]);
    days.rows.push([button('✖ Keep as is', `v:${b.id}`)]);
    return { text: lines.join('\n'), rows: days.rows };
  },

  move_time(ctx, d) {
    const { base, steps } = ctx.wiz;
    const b = d.plan.booking;
    const lines = ['<b>Move class</b>', card(b, ctx.today), ''];
    if (d.plan.room.id !== b.room_id) lines.push(`New room: ${esc(d.plan.room.name)}`);
    lines.push(`New day: ${dayLabel(d.day, ctx.today)}`, '');
    lines.push(d.slots.length ? 'Pick the new start time.' : 'No free start times on this day.');
    const rows = timeButtons(ctx, d.slots);
    rows.push([button('‹ Back', wizard(base, without(steps, 'd', 't'))), button('✖ Keep as is', `v:${b.id}`)]);
    return { text: lines.join('\n'), rows };
  },

  move_confirm(ctx, d) {
    const { base, steps } = ctx.wiz;
    const b = d.plan.booking;
    const target = `${dayLabel(d.day, ctx.today)}, ${d.from}–${d.to} · ${esc(d.plan.room.name)}`;
    const current = `${dayLabel(b.day, ctx.today)}, ${span(b)} · ${esc(b.room)}`;
    const back = wizard(base, without(steps, 't'));
    if (!d.free) {
      return {
        text: `<b>That time is no longer free</b>\n${target}`,
        rows: [[button('Pick another time', back)], [button('✖ Keep as is', `v:${b.id}`)]],
      };
    }
    return {
      text: [
        '<b>Move this class?</b>',
        '',
        `<b>${esc(b.class)}</b> · ${b.minutes} min · ${esc(b.trainer)}`,
        `From: ${current}`,
        `To: ${target}`,
      ].join('\n'),
      rows: [
        [button('✅ Move it', wizard(`E:${b.id}`, steps))],
        [button('‹ Back', back), button('✖ Keep as is', `v:${b.id}`)],
      ],
    };
  },

  moved(ctx, d) {
    if (d.ok === false) return taken(ctx, d);
    const b = d.booking;
    const lines = [`<b>${d.already ? 'Nothing to change' : 'Moved'}</b>`, '', card(b, ctx.today)];
    if (!d.already) lines.push('', `Was: ${dayLabel(d.was.day, ctx.today)}, ${span(d.was)} · ${esc(d.was.room)}`);
    return {
      text: lines.join('\n'),
      rows: [[button('Open class', `v:${b.id}`), button('📅 That day', `s:${packDay(b.day)}`)], MENU],
      toast: d.already ? 'Same time as before' : 'Moved',
    };
  },

  people(ctx, d) {
    const waiting = d.people.filter((p) => p.status === 'pending').length;
    const label = (p) => {
      if (p.status === 'pending') return `⏳ ${p.name} · wants access`;
      if (p.status === 'blocked') return `⛔ ${p.name} · blocked`;
      return `${p.name} · ${p.role}${p.self ? ' (you)' : ''}`;
    };
    const rows = d.people.slice(0, 60).map((p) => [button(label(p).slice(0, 60), `pv:${p.id}`)]);
    rows.push(MENU);
    return {
      text: `<b>People</b>\n${waiting ? `${waiting} waiting to be let in.` : 'Nobody is waiting.'} Open a person to change their access.`,
      rows,
    };
  },

  person(ctx, d) {
    const p = d.person;
    const state =
      p.status === 'pending' ? 'Waiting to be let in' : p.status === 'blocked' ? 'Blocked' : p.role === 'admin' ? 'Admin' : 'Trainer';
    const lines = [`<b>${esc(p.name)}</b>${p.username ? ` (@${esc(p.username)})` : ''}${p.self ? ' · you' : ''}`, state];
    if (p.upcoming > 0) lines.push(`Upcoming classes: ${p.upcoming}`);
    if (p.status === 'blocked' && p.upcoming > 0) lines.push('Their classes stay on the schedule until you move or cancel them.');
    const set = (text, action) => [button(text, `ps:${p.id}:${action}`)];
    const rows = [];
    if (p.status === 'pending') rows.push(set('✅ Let in as trainer', 'trainer'), set('Let in as admin', 'admin'), set('⛔ Block', 'block'));
    else if (p.status === 'blocked') rows.push(set('Unblock as trainer', 'trainer'));
    else if (p.role === 'admin') rows.push(set('Make trainer', 'trainer'), set('⛔ Block', 'block'));
    else rows.push(set('Make admin', 'admin'), set('⛔ Block', 'block'));
    rows.push([button('‹ People', 'pl')]);
    const toasts = { trainer: 'Now a trainer', admin: 'Now an admin', blocked: 'Blocked' };
    return { text: lines.join('\n'), rows, toast: toasts[d.note] };
  },

  ask(ctx, d) {
    return { text: question(d.asking, d.current), rows: [[button('✖ Cancel', d.asking === 'class_new' ? 'cl' : 'ro')]] };
  },

  manage(ctx, d) {
    if (d.ok === false) {
      const problem =
        d.error === 'duplicate'
          ? `There is already one called <b>${esc(d.name)}</b>.`
          : 'I could not read that.';
      return {
        text: `${problem}\n\n${question(d.asking)}`,
        rows: [[button('✖ Cancel', d.asking === 'class_new' ? 'cl' : 'ro')]],
      };
    }
    if (d.list === 'rooms') {
      const lines = ['<b>Rooms</b>'];
      if (!d.rooms.length) lines.push('No rooms yet.');
      for (const room of d.rooms) {
        const facts = [room.capacity ? `up to ${room.capacity}` : null, room.upcoming ? `${room.upcoming} upcoming` : null, room.active ? null : 'off']
          .filter(Boolean)
          .join(' · ');
        lines.push(`${esc(room.name)}${facts ? ` · ${facts}` : ''}`);
      }
      if (d.rooms.length) lines.push('', 'Tap a room to switch it on or off. A room that is off cannot be booked; classes already in it stay.');
      const rows = d.rooms.map((room) => [
        button(`${room.active ? '✅' : '🚫'} ${room.name}`.slice(0, 40), `rt:${room.id}`),
        button('✏️ Rename', `rr:${room.id}`),
      ]);
      rows.push([button('➕ Add a room', 'rn')], MENU);
      return { text: lines.join('\n'), rows };
    }
    const lines = ['<b>Class types</b>'];
    lines.push(d.classes.length ? 'Tap one to switch it on or off. Classes already booked stay.' : 'No class types yet.');
    const rows = d.classes.map((c) => [button(`${c.active ? '✅' : '🚫'} ${c.name} · ${c.minutes} min`.slice(0, 60), `ct:${c.id}`)]);
    rows.push([button('➕ Add a class type', 'cn')], MENU);
    return { text: lines.join('\n'), rows };
  },

  calendar(ctx, d) {
    const lines = [
      '<b>Calendar feed</b>',
      'Subscribe to one of these links in Google Calendar (Other calendars, From URL), Apple Calendar or Outlook. The calendar then shows the classes and keeps itself up to date. It is read-only: changes are still made here.',
      '',
      'Your classes:',
      `<code>${esc(d.mine)}</code>`,
      '',
      'The whole studio:',
      `<code>${esc(d.studio)}</code>`,
    ];
    for (const room of d.rooms) lines.push('', `${esc(room.name)}:`, `<code>${esc(room.url)}</code>`);
    return { text: lines.join('\n'), rows: [MENU] };
  },
};

function question(asking, current) {
  if (asking === 'room_new') {
    return 'Send me the name of the new room. To say how many people fit, add a number after a comma, like <code>Studio C, 20</code>.';
  }
  if (asking === 'room_rename') {
    return `Send me the new name${current ? ` for <b>${esc(current)}</b>` : ''}. Add a number after a comma to change how many people fit.`;
  }
  return 'Send me the class type and how many minutes it lasts (15 to 480), like <code>Yoga, 60</code>.';
}

function refusal(d) {
  return { text: `<b>Not possible</b>\n${REFUSALS[d.error]}`, rows: [MENU], toast: REFUSALS[d.error] };
}

// Telegram refuses messages over 4096 characters. Lines never split a tag, so
// cutting at a line break keeps the HTML valid.
function fit(text) {
  if (text.length <= 4000) return text;
  const cut = text.lastIndexOf('\n', 3900);
  return `${text.slice(0, cut > 0 ? cut : 3900)}\n…`;
}

function render(route, data, begin) {
  const ctx = { route, begin, today: begin.today, wiz: route.wiz };
  const d = data || {};
  const view = d.ok === false && REFUSALS[d.error] ? refusal(d) : SCREENS[route.screen](ctx, d);

  const calls = [];
  const { reply } = route;
  if (reply.callback_id) {
    const body = { callback_query_id: reply.callback_id };
    if (view.toast) body.text = view.toast.slice(0, 190);
    calls.push({ method: 'answerCallbackQuery', body });
  }
  const body = {
    chat_id: reply.chat_id,
    text: fit(view.text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  // Without buttons the field is left out: an edit then also removes the old keyboard.
  if (view.rows && view.rows.length) body.reply_markup = { inline_keyboard: view.rows };
  calls.push(
    reply.message_id
      ? { method: 'editMessageText', body: { ...body, message_id: reply.message_id } }
      : { method: 'sendMessage', body },
  );
  return calls;
}

// --- exports for the unit tests (scripts/build.mjs drops everything below) ---
Object.assign(module.exports, { render, SCREENS, REFUSALS });
