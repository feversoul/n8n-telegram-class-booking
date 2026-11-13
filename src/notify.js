// The "Write notifications" Code node: turn rows of studio.outbox into
// messages. These go to people who did not tap anything: a trainer whose class
// an admin moved, the admins when someone asks for access, reminders.

function classLines(b, today) {
  return [
    `<b>${esc(b.class)}</b> · ${b.minutes} min`,
    `Room: ${esc(b.room)}`,
    `When: ${dayLabel(b.day, today)}, ${b.from}–${b.to}`,
    `Trainer: ${esc(b.trainer)}`,
  ].join('\n');
}

function leadTime(minutes) {
  if (minutes === 1440) return 'Tomorrow at this time';
  if (minutes > 1440 && minutes % 1440 === 0) return `In ${minutes / 1440} days`;
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? 'In 1 hour' : `In ${minutes / 60} hours`;
  return `In ${minutes} minutes`;
}

const NOTIFICATIONS = {
  access_request(p) {
    return {
      text: `<b>${esc(p.name)}</b>${p.username ? ` (@${esc(p.username)})` : ''} wants to use the studio bot.`,
      rows: [[button('Review', `pv:${p.person_id}`)]],
    };
  },

  access_granted(p, ctx) {
    const role = p.role === 'admin' ? 'an admin' : 'a trainer';
    return {
      text: p.first_time
        ? `You are in. You can now use the <b>${esc(ctx.studio.name)}</b> bot as ${role}.`
        : `Your role at <b>${esc(ctx.studio.name)}</b> changed: you are now ${role}.`,
      rows: [[button('Open the menu', 'h')]],
    };
  },

  booked(p, ctx) {
    const who = p.yours ? `${esc(p.actor)} booked you for` : `${esc(p.actor)} booked`;
    const what = p.count > 1 ? `${p.count} weekly classes, starting with:` : 'a class:';
    return {
      text: `${who} ${what}\n\n${classLines(p.booking, ctx.today)}`,
      rows: [[button('Open class', `v:${p.booking.id}`)]],
    };
  },

  moved(p, ctx) {
    return {
      text: [
        `${esc(p.actor)} moved ${p.yours ? 'your class' : 'a class'}.`,
        '',
        classLines(p.booking, ctx.today),
        '',
        `Was: ${dayLabel(p.was.day, ctx.today)}, ${p.was.from}–${p.was.to} · ${esc(p.was.room)}`,
      ].join('\n'),
      rows: [[button('Open class', `v:${p.booking.id}`)]],
    };
  },

  cancelled(p, ctx) {
    const what = p.count > 1 ? `${p.count} classes, starting with:` : p.yours ? 'your class:' : 'a class:';
    return {
      text: `${esc(p.actor)} cancelled ${what}\n\n${classLines(p.booking, ctx.today)}`,
      rows: [[button('📅 That day', `s:${packDay(p.booking.day)}`)]],
    };
  },

  reminder(p, ctx) {
    return {
      text: `<b>Reminder</b> · ${leadTime(p.minutes)}\n\n${classLines(p.booking, ctx.today)}`,
      rows: [[button('Open class', `v:${p.booking.id}`)]],
    };
  },

  digest(p) {
    const lines = [`<b>Your classes today</b>, ${dayName(p.day)}`, ''];
    for (const b of p.classes) lines.push(`${b.from}–${b.to}  ${esc(b.class)} · ${esc(b.room)}`);
    return { text: lines.join('\n'), rows: [[button("📅 Today's schedule", 's')]] };
  },

  alert(p) {
    const lines = ['<b>The studio bot hit an error</b>', `Workflow: ${esc(p.workflow)}`];
    if (p.node) lines.push(`Step: ${esc(p.node)}`);
    lines.push('', esc(p.message));
    if (p.url) lines.push('', esc(p.url));
    return { text: lines.join('\n'), rows: [] };
  },
};

// ctx = the answer of studio.claim_due: { studio, today, messages }
function notifications(ctx) {
  return ctx.messages.map((message) => {
    const write = NOTIFICATIONS[message.kind];
    const view = write
      ? write(message.payload, ctx)
      : { text: `Studio bot: ${esc(message.kind)}`, rows: [] };
    const body = { chat_id: message.chat_id, text: view.text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (view.rows.length) body.reply_markup = { inline_keyboard: view.rows };
    return { id: message.id, method: 'sendMessage', body };
  });
}

// --- exports for the unit tests (scripts/build.mjs drops everything below) ---
Object.assign(module.exports, { notifications, NOTIFICATIONS, leadTime });
