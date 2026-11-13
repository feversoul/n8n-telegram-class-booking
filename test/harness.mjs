// Drives the bot the way a person would, against the test stack:
// real n8n, real Postgres, and mock-telegram.mjs in place of api.telegram.org.
//
//   const anna = new Person(200, 'Anna');
//   let screen = await anna.say('/start');
//   screen = await anna.tap('Book a class');
//
// say() and tap() post the same update Telegram would post to n8n's webhook and
// return what the bot then showed: { text, buttons, toast }.

import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export const MOCK = process.env.MOCK_URL ?? 'http://localhost:58081';
export const PROJECT = process.env.COMPOSE_PROJECT ?? 'studio-bot-test';

let nextUpdateId = Math.floor(Date.now() / 1000) * 1000;
let nextUserMessageId = 1;

export async function mockState() {
  return (await fetch(`${MOCK}/__state`)).json();
}

export async function waitForWebhook(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { webhook } = await mockState();
      if (webhook?.url) return webhook;
    } catch {
      /* stack still starting */
    }
    await sleep(1000);
  }
  throw new Error('n8n never registered the Telegram webhook with the mock');
}

// Run SQL in the test database; returns the raw psql output (unaligned, tuples only).
export function sql(query) {
  return execFileSync(
    'docker',
    ['compose', '-p', PROJECT, 'exec', '-T', 'postgres', 'psql', '-U', 'studio', '-d', 'studio', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { encoding: 'utf8' },
  ).trim();
}

export async function post(update) {
  const { webhook } = await mockState();
  const response = await fetch(webhook.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': webhook.secret_token },
    body: JSON.stringify(update),
  });
  if (!response.ok) throw new Error(`webhook answered ${response.status}`);
}

// Wait until the mock has seen no new call for a moment: the execution that
// handled the last update, including the notifications it sends, is over.
export async function quiet(ms = 700) {
  let { calls } = await mockState();
  let since = Date.now();
  for (;;) {
    await sleep(100);
    const now = (await mockState()).calls;
    if (now.length !== calls.length) {
      calls = now;
      since = Date.now();
    } else if (Date.now() - since >= ms) {
      return calls;
    }
  }
}

function toScreen(call, batch) {
  const rows = call.body.reply_markup?.inline_keyboard ?? [];
  const toast = batch.find((c) => c.method === 'answerCallbackQuery')?.body.text ?? null;
  const screen = {
    method: call.method,
    ok: call.response.ok,
    message_id: call.method === 'editMessageText' ? Number(call.body.message_id) : call.response.result?.message_id,
    text: call.body.text,
    rows: rows.map((row) => row.map((b) => ({ text: b.text, data: b.callback_data }))),
    toast,
  };
  screen.buttons = screen.rows.flat();
  screen.labels = screen.buttons.map((b) => b.text);
  screen.button = (label) =>
    screen.buttons.find((b) => b.text === label) ?? screen.buttons.find((b) => b.text.includes(label));
  return screen;
}

export class Person {
  constructor(id, name, username) {
    this.id = id;
    this.name = name;
    this.username = username;
    this.screen = null;
  }

  get from() {
    return { id: this.id, is_bot: false, first_name: this.name, ...(this.username ? { username: this.username } : {}) };
  }

  get chat() {
    return { id: this.id, type: 'private', first_name: this.name };
  }

  messageUpdate(text) {
    return {
      update_id: nextUpdateId++,
      message: { message_id: nextUserMessageId++, from: this.from, chat: this.chat, date: Math.floor(Date.now() / 1000), text },
    };
  }

  tapUpdate(data, messageId) {
    return {
      update_id: nextUpdateId++,
      callback_query: {
        id: `cb${nextUpdateId}`,
        from: this.from,
        chat_instance: '1',
        data,
        message: { message_id: messageId, chat: this.chat, date: Math.floor(Date.now() / 1000), text: '(previous screen)' },
      },
    };
  }

  // Post an update and return the bot's answer to it.
  async send(update, { expectReply = true } = {}) {
    const before = (await mockState()).calls.length;
    await post(update);
    const deadline = Date.now() + 20_000;
    const mine = (c) =>
      String(c.body.chat_id) === String(this.id) && (c.method === 'sendMessage' || c.method === 'editMessageText');
    for (;;) {
      const batch = (await mockState()).calls.slice(before);
      const replies = batch.filter(mine);
      if (replies.length) {
        const all = (await quiet()).slice(before);
        // If an edit was refused and the bot fell back to a new message, that is the answer.
        const answers = all.filter(mine).filter((c) => c.response.ok);
        const answer = answers.find((c) => c.method === replies[0].method) ?? answers[0] ?? replies[0];
        this.screen = toScreen(answer, all);
        this.screen.calls = all;
        return this.screen;
      }
      if (Date.now() > deadline) {
        if (!expectReply) return null;
        throw new Error(`no reply to ${JSON.stringify(update).slice(0, 200)}`);
      }
      await sleep(100);
    }
  }

  say(text) {
    return this.send(this.messageUpdate(text));
  }

  // Tap a button on the last screen this person saw (or on a given screen).
  tap(label, screen = this.screen) {
    const found = screen?.button(label);
    if (!found) throw new Error(`no button "${label}" on screen with buttons: ${JSON.stringify(screen?.labels)}`);
    return this.send(this.tapUpdate(found.data, screen.message_id));
  }

  // Tap with raw callback data: an old button, or one the bot never showed.
  tapData(data, messageId = this.screen?.message_id ?? 1) {
    return this.send(this.tapUpdate(data, messageId));
  }

  // A message the bot sent this person on its own (a notification), newest first.
  async notification(pattern, { since = 0, timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { calls } = await mockState();
      const hit = calls
        .filter((c) => c.seq > since && c.method === 'sendMessage' && String(c.body.chat_id) === String(this.id))
        .reverse()
        .find((c) => pattern.test(c.body.text));
      if (hit) return toScreen(hit, []);
      if (Date.now() > deadline) throw new Error(`no notification matching ${pattern} for ${this.name}`);
      await sleep(250);
    }
  }
}

export async function lastSeq() {
  return (await mockState()).calls.length;
}
