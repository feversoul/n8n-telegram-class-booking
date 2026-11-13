// Shared by every Code node. scripts/build.mjs pastes this file in front of
// route.js, render.js and notify.js, because n8n Code nodes cannot import.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Everything that came from a person or the database goes through esc()
// before it is put into a message, because messages are sent as HTML.
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// Days travel as "2026-11-14" in data and as "20261114" inside buttons. They
// are plain calendar dates in the studio's time zone; Postgres owns the clock.
const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
const addDays = (iso, count) => {
  const date = asDate(iso);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
const dayName = (iso) => {
  const date = asDate(iso);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
};
const dayLabel = (iso, today) => {
  if (iso === today) return `${dayName(iso)} (today)`;
  if (iso === addDays(today, 1)) return `${dayName(iso)} (tomorrow)`;
  return dayName(iso);
};
const packDay = (iso) => iso.replace(/-/g, '');
const unpackDay = (packed) => {
  if (!/^\d{8}$/.test(packed ?? '')) return null;
  const iso = `${packed.slice(0, 4)}-${packed.slice(4, 6)}-${packed.slice(6, 8)}`;
  const date = asDate(iso);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
};
const packTime = (hhmm) => hhmm.replace(':', '');
const unpackTime = (packed) => {
  if (!/^\d{4}$/.test(packed ?? '')) return null;
  const hours = Number(packed.slice(0, 2));
  const minutes = Number(packed.slice(2, 4));
  return hours < 24 && minutes < 60 ? `${packed.slice(0, 2)}:${packed.slice(2, 4)}` : null;
};

const button = (text, data) => ({ text, callback_data: data });
const rowsOf = (items, perRow) => {
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  return rows;
};

// A booking or a move in progress is not stored anywhere. Each button carries
// every choice made so far, for example "b:c2:r1:d20261114:t0900":
//   c class type   r room (0 = ask)   d day   t start time
//   p trainer (0 = ask)   n weeks to repeat   w week shown in the day picker
// So there is no session to expire or to get out of step with the screen, and
// "Back" is simply the same data with the last choice left out. Telegram
// allows 64 bytes per button; the longest of these is under 50.
const STEP_KEYS = ['c', 'r', 'd', 't', 'p', 'n', 'w'];
const wizard = (base, steps) =>
  [base]
    .concat(
      STEP_KEYS.filter((key) => steps[key] !== undefined && steps[key] !== null).map(
        (key) => `${key}${steps[key]}`,
      ),
    )
    .join(':');
const without = (steps, ...keys) =>
  Object.fromEntries(Object.entries(steps).filter(([key]) => !keys.includes(key)));
const readSteps = (parts) => {
  const steps = {};
  for (const part of parts) {
    const key = part[0];
    const value = part.slice(1);
    if (!STEP_KEYS.includes(key)) continue;
    if (key === 'd' && unpackDay(value)) steps.d = value;
    else if (key === 't' && unpackTime(value)) steps.t = value;
    else if ('crpnw'.includes(key) && /^\d{1,9}$/.test(value)) steps[key] = String(Number(value));
  }
  return steps;
};

// --- exports for the unit tests (scripts/build.mjs drops everything below) ---
Object.assign(module.exports, {
  esc, addDays, dayName, dayLabel, packDay, unpackDay, packTime, unpackTime,
  button, rowsOf, wizard, without, readSteps,
});
