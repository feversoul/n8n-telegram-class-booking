// A strict stand-in for the Telegram Bot API, used by the end-to-end tests.
//
// n8n's Telegram credential has a "Base URL" field, so the real, unmodified
// workflows can be pointed at this server instead of api.telegram.org. It
// records every call and rejects the things the real API rejects and that are
// easy to get wrong in a bot: empty text, text over 4096 characters, button
// payloads over 64 bytes, unsupported or unbalanced HTML, and edits that change
// nothing.
//
//   POST /bot<token>/<method>   Bot API call (JSON body)
//   GET  /__state               { webhook, calls }
//   POST /__reset               forget calls, messages and blocked chats
//   POST /__block               { chat_id } -> sendMessage to it answers 403

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8081);
const ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler']);

let webhook = null;
let calls = [];
let messages = new Map(); // "chat:message_id" -> JSON of what the user sees
let blocked = new Set();
let nextMessageId = 1000;

const ok = (result) => ({ status: 200, body: { ok: true, result } });
const fail = (code, description) => ({
  status: code,
  body: { ok: false, error_code: code, description },
});

function htmlProblem(text) {
  const stack = [];
  const tag = /<\/?([a-zA-Z-]+)(?:\s[^<>]*)?>/g;
  const withoutTags = text.replace(tag, (whole, name) => {
    const lower = name.toLowerCase();
    if (!ALLOWED_TAGS.has(lower)) {
      stack.push(`!unsupported:${lower}`);
      return '';
    }
    if (whole.startsWith('</')) {
      if (stack.pop() !== lower) stack.push(`!unbalanced:${lower}`);
    } else {
      stack.push(lower);
    }
    return '';
  });
  const bad = stack.find((entry) => entry.startsWith('!'));
  if (bad) return `can't parse entities: ${bad.slice(1)}`;
  if (stack.length) return `can't parse entities: unclosed tag "${stack.at(-1)}"`;
  if (/[<>]/.test(withoutTags)) return "can't parse entities: unescaped < or >";
  if (/&(?!(lt|gt|amp|quot|#\d+|#x[0-9a-fA-F]+);)/.test(withoutTags))
    return "can't parse entities: unescaped &";
  return null;
}

function markupProblem(markup) {
  if (markup === undefined || markup === null) return null;
  if (typeof markup === 'string') {
    try {
      markup = JSON.parse(markup);
    } catch {
      return "can't parse reply keyboard markup JSON object";
    }
  }
  const rows = markup.inline_keyboard;
  if (rows === undefined) return null;
  if (!Array.isArray(rows)) return 'inline_keyboard must be an array of arrays';
  for (const row of rows) {
    if (!Array.isArray(row)) return 'inline_keyboard must be an array of arrays';
    for (const button of row) {
      if (typeof button.text !== 'string' || button.text.length === 0)
        return 'inline keyboard button text is empty';
      const payloads = ['callback_data', 'url'].filter((key) => button[key] !== undefined);
      if (payloads.length !== 1) return 'inline keyboard button must have exactly one action';
      if (button.callback_data !== undefined) {
        const bytes = Buffer.byteLength(String(button.callback_data));
        if (bytes < 1 || bytes > 64) return 'BUTTON_DATA_INVALID';
      }
    }
  }
  return null;
}

function textProblem(body) {
  if (typeof body.text !== 'string' || body.text.trim().length === 0)
    return 'message text is empty';
  if (body.text.length > 4096) return 'message is too long';
  if (body.parse_mode === 'HTML') return htmlProblem(body.text);
  return null;
}

function visible(body) {
  return JSON.stringify({ text: body.text, reply_markup: body.reply_markup ?? null });
}

function handle(method, body) {
  switch (method) {
    case 'getMe':
      return ok({ id: 42, is_bot: true, first_name: 'Mock Studio Bot', username: 'mock_studio_bot' });
    case 'setWebhook':
      webhook = { url: body.url, secret_token: body.secret_token, allowed_updates: body.allowed_updates };
      return ok(true);
    case 'deleteWebhook':
      webhook = null;
      return ok(true);
    case 'getWebhookInfo':
      return ok({ url: webhook?.url ?? '', pending_update_count: 0 });
    case 'answerCallbackQuery':
      if (!body.callback_query_id) return fail(400, 'Bad Request: query is too old or invalid');
      return ok(true);
    case 'sendMessage': {
      if (body.chat_id === undefined || body.chat_id === '') return fail(400, 'Bad Request: chat_id is empty');
      if (blocked.has(String(body.chat_id)))
        return fail(403, 'Forbidden: bot was blocked by the user');
      const problem = textProblem(body) ?? markupProblem(body.reply_markup);
      if (problem) return fail(400, `Bad Request: ${problem}`);
      const message_id = nextMessageId++;
      messages.set(`${body.chat_id}:${message_id}`, visible(body));
      return ok({ message_id, chat: { id: Number(body.chat_id) }, date: Math.floor(Date.now() / 1000), text: body.text });
    }
    case 'editMessageText': {
      const key = `${body.chat_id}:${body.message_id}`;
      const problem = textProblem(body) ?? markupProblem(body.reply_markup);
      if (problem) return fail(400, `Bad Request: ${problem}`);
      if (!messages.has(key)) return fail(400, 'Bad Request: message to edit not found');
      if (messages.get(key) === visible(body))
        return fail(400, 'Bad Request: message is not modified');
      messages.set(key, visible(body));
      return ok({ message_id: Number(body.message_id), chat: { id: Number(body.chat_id) }, text: body.text });
    }
    default:
      return fail(404, `Not Found: method ${method} is not mocked`);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const url = new URL(req.url, 'http://mock');
  const body = await readBody(req);

  if (url.pathname === '/__state') return send(200, { webhook, calls });
  if (url.pathname === '/__reset') {
    calls = [];
    messages = new Map();
    blocked = new Set();
    return send(200, { ok: true });
  }
  if (url.pathname === '/__block') {
    blocked.add(String(body.chat_id));
    return send(200, { ok: true });
  }

  const match = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
  if (!match) return send(404, { ok: false, error_code: 404, description: 'Not Found' });
  const [, , method] = match;
  const merged = { ...Object.fromEntries(url.searchParams), ...body };
  if (typeof merged.reply_markup === 'string') {
    try {
      merged.reply_markup = JSON.parse(merged.reply_markup);
    } catch {
      /* markupProblem reports it */
    }
  }
  const outcome = handle(method, merged);
  calls.push({ seq: calls.length + 1, method, body: merged, response: outcome.body });
  send(outcome.status, outcome.body);
});

server.listen(PORT, () => console.log(`mock Telegram API on :${PORT}`));
