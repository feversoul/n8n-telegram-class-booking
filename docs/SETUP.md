# Step by step

From nothing to a working studio bot. Do part 1, then either part 2A or part 2B, then part 3.

- [1. Create the bot in Telegram](#1-create-the-bot-in-telegram)
- [2A. Install into the n8n you already have](#2a-install-into-the-n8n-you-already-have) (n8n Cloud or your own)
- [2B. Install everything with Docker](#2b-install-everything-with-docker) (no n8n yet)
- [3. First run in the chat](#3-first-run-in-the-chat)
- [4. Day to day](#4-day-to-day)
- [5. Changing settings](#5-changing-settings)
- [6. If something does not work](#6-if-something-does-not-work)
- [7. Updating](#7-updating)

## 1. Create the bot in Telegram

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Send a display name, for example `Flex Studio`.
4. Send a username that ends in `bot`, for example `flex_studio_bot`.
5. BotFather answers with a token that looks like `123456789:AAH...`. Copy it. Anyone with this token controls the bot, so treat it like a password.
6. Optional, for the command menu: send `/setcommands`, pick your bot, and paste:

   ```
   schedule - Rooms, classes and free times for a day
   book - Book a room for a class
   my - Your upcoming classes
   calendar - Links for Google, Apple or Outlook calendars
   help - What this bot does
   ```

Do not send `/start` to your new bot yet. The first person who does becomes the admin, and it only works once the install is finished.

## 2A. Install into the n8n you already have

You need a PostgreSQL database (version 13 or newer) that your n8n can reach. A free database at Supabase or Neon is enough.

### Prepare the database

1. Open [`db/install.sql`](../db/install.sql), copy all of it, paste it into your database's SQL editor and run it. With `psql` instead: `psql "YOUR_DATABASE_URL" -f db/install.sql`.

   It creates a schema called `studio` and touches nothing else. Running it twice does no harm.

2. Run this, with your own values:

   ```sql
   SELECT studio.setup(
     bot_token    => '123456789:AAH...',
     studio_name  => 'Flex Studio',
     timezone     => 'Europe/Berlin',
     calendar_url => 'https://YOUR-N8N-ADDRESS/webhook/studio-calendar'
   );
   ```

   - `timezone` is a name from the tz database, such as `Europe/Berlin`, `America/New_York` or `Asia/Singapore`. Every time the bot shows is in this zone.
   - `calendar_url` is your n8n address followed by `/webhook/studio-calendar`. On n8n Cloud the address looks like `https://yourname.app.n8n.cloud`.

   The answer should read like `Flex Studio: Europe/Berlin, open 06:00-22:00, 30-minute slots, bot token set`.

### Create the two credentials

The names matter: the imported nodes look for credentials with exactly these names.

3. In n8n, open **Credentials** and create one of type **Postgres**. Fill in host, database, user, password and port from your database provider. Most hosted databases need SSL switched on. Rename the credential to `Studio Bot Postgres` and save. n8n tests the connection when you save.
4. Create one of type **Telegram API**. Paste the bot token into **Access Token**. Rename it to `Studio Bot Telegram` and save.

### Import the workflows

5. Download the four files from [`workflows/`](../workflows).
6. For each file: create a new workflow, open the **⋯** menu at the top, choose **Import from file** and pick the file. Save.
7. Open a few nodes in **Studio Bot · 1 Chat** and check that the credential field shows `Studio Bot Postgres` (and `Studio Bot Telegram` on the first node). If a field is empty, pick the credential by hand.
8. Optional: in workflows 1, 2 and 3, open the **⋯** menu, **Settings**, and set **Error Workflow** to `Studio Bot · 4 Error alerts`. Admins then get a Telegram message when a run fails.
9. Publish all four workflows with the button at the top right (in n8n 1.x it is the **Active** switch). When workflow 1 goes live, n8n tells Telegram where to send messages.

Continue with [part 3](#3-first-run-in-the-chat).

## 2B. Install everything with Docker

You need a machine with Docker and a public `https` address that leads to it. Telegram only delivers messages to `https`.

1. Get the address first. Either:
   - a domain you own, with a reverse proxy (Caddy, nginx, Traefik) that forwards to port 5678 on this machine and handles the certificate, or
   - a tunnel service that gives you an `https` address for a local port and forwards it to port 5678.
2. Get the files:

   ```bash
   git clone https://github.com/lunox-work/n8n-telegram-class-booking.git
   cd n8n-telegram-class-booking
   cp .env.example .env
   ```

3. Open `.env` in an editor and fill in every line:

   | Line | What to put |
   | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | The token from BotFather. |
   | `WEBHOOK_URL` | Your public address, ending in a slash: `https://bot.example.com/` |
   | `STUDIO_NAME` | The name people see in the bot. |
   | `STUDIO_TIMEZONE` | For example `Europe/Berlin`. |
   | `POSTGRES_PASSWORD` | Any long random text. |
   | `N8N_ENCRYPTION_KEY` | Any long random text. Keep it: n8n uses it to protect stored credentials. |

4. Start it:

   ```bash
   docker compose up -d
   docker compose logs -f n8n
   ```

   Wait for the lines `studio-bot: workflows imported and published` and `Editor is now accessible`. Press Ctrl+C to stop watching the log; the bot keeps running.

5. Optional: open your address in a browser. n8n asks you to create an owner account, and you then see the four workflows, all published.

Continue with part 3.

## 3. First run in the chat

Do these in order. You are the admin from step 1 on.

1. Open your bot in Telegram and send `/start`. The reply says you are signed in as an admin. If the bot stays silent, go to [part 6](#6-if-something-does-not-work).
2. Add your rooms. Tap **Rooms**, then **Add a room**, and send the name. Add a number after a comma to record how many people fit: `Studio A, 20`. Repeat for each room.
3. Add your class types. Send `/classtypes`, tap **Add a class type**, and send the name and the length in minutes: `Yoga, 60`. Repeat for each type. The length decides which start times are offered.
4. Invite your trainers. Send them the bot's link, `https://t.me/your_bot_username`. Each of them sends `/start`.
5. Let them in. For every request you get a message with a **Review** button. Tap it, then **Let in as trainer** (or **Let in as admin**). The person is told at once.
6. Try a booking. Send `/book`, pick a class type, a room, a day and a start time, then tap **Book it**.

That is the whole setup.

## 4. Day to day

**See what is on.** `/schedule` shows today, room by room, with the classes and the free windows. Use the arrows to change the day.

**Book a class.** `/book`, then class type, room, day, time. On the last card, **Book it** books once; **Weekly × 4**, **× 8** or **× 12** books the same time for that many weeks and tells you if a week could not be booked.

**Move a class.** `/my`, open the class, **Move**, pick the new day and time. **Change room** is on the day screen.

**Cancel a class.** `/my`, open the class, **Cancel class**. For a weekly series you can cancel one class or that class and all later ones.

**As an admin**, you can also:

- book for someone else: on the last card of a booking, tap **Change trainer**;
- move or cancel anyone's class: `/schedule`, go to the day, **Open a class**;
- change who has access: `/people`, open a person, then make them trainer or admin, or block them;
- switch a room or class type off: `/rooms` or `/classtypes`, tap it. Classes already booked stay.

**Put the schedule in your calendar.** `/calendar` gives three kinds of links: your own classes, the whole studio, and one per room. Copy a link, then:

- Google Calendar: **Other calendars**, **+**, **From URL**, paste.
- Apple Calendar: **File**, **New Calendar Subscription**, paste.
- Outlook: **Add calendar**, **Subscribe from web**, paste.

The calendar is read-only and updates on the calendar app's own schedule, which for Google can be several hours.

**Messages the bot sends on its own:** a reminder 24 hours and 1 hour before each of your classes, a summary at 07:00 on days you teach, and a notice when someone else books, moves or cancels a class of yours. Admins are also told when a trainer books, moves or cancels.

## 5. Changing settings

Settings are changed with one SQL statement. Only what you name is changed.

Where to run it:

- Part 2A: your database's SQL editor.
- Part 2B: `docker compose exec postgres psql -U studio -d studio`, then type the statement.

Examples:

```sql
-- Opening hours
SELECT studio.setup(opens => '07:00', closes => '21:00');

-- Closed on Sundays (1 = Monday ... 7 = Sunday)
SELECT studio.setup(closed_weekdays => '{7}');

-- Start times every 15 minutes instead of every 30
SELECT studio.setup(slot_minutes => 15);

-- Reminders 2 hours and 30 minutes before a class
SELECT studio.setup(reminder_minutes => '{120,30}');

-- Morning summary at 06:30, or none at all
SELECT studio.setup(digest_time => '06:30');
UPDATE studio.settings SET digest_time = NULL;

-- Do not tell admins about every trainer booking
SELECT studio.setup(notify_admins => false);

-- New bot token (also update the Telegram credential in n8n)
SELECT studio.setup(bot_token => '123456789:NEW...');
```

The full list is in the [README](../README.md#settings).

## 6. If something does not work

**The bot does not answer at all.**

1. In n8n, open **Studio Bot · 1 Chat** and look at the **Executions** tab.
2. No executions: Telegram is not reaching n8n. Open this in a browser, with your token in place:

   ```
   https://api.telegram.org/bot123456789:AAH.../getWebhookInfo
   ```

   - `"url": ""` means the workflow is not published. Publish workflow 1.
   - A `url` that is not your public `https` address means n8n does not know its own address. Part 2B: correct `WEBHOOK_URL` in `.env` and run `docker compose up -d`. Part 2A: set the webhook address in your n8n hosting settings.
   - `last_error_message` tells you what Telegram ran into, for example a certificate problem.
3. Failed executions: open one. The red node shows the error. The common ones are below.

**`Studio bot is not set up: run SELECT studio.setup(bot_token => ...)`.** The bot token is missing in the database. Run the statement from part 2A, step 2.

**`function studio.begin(jsonb) does not exist` or `schema "studio" does not exist`.** `db/install.sql` was not run on the database that the `Studio Bot Postgres` credential points to. Run it there.

**A node says the credential is missing.** The credential names did not match on import. Open the node and choose the credential, or rename your credentials to `Studio Bot Postgres` and `Studio Bot Telegram` and import the file again.

**`permission denied to create extension "btree_gist"`.** The database user may not add extensions. Run `CREATE EXTENSION btree_gist;` once as the database owner, or enable `btree_gist` in your provider's extensions page, then run `db/install.sql` again.

**The times are wrong.** Set your zone: `SELECT studio.setup(timezone => 'Europe/Berlin');`

**Somebody else became the admin, or you locked yourself out.** Look at the list, then promote yourself:

```sql
SELECT id, telegram_id, name, role, status FROM studio.person;
UPDATE studio.person SET role = 'admin', status = 'active' WHERE id = 1;   -- your row
```

**No reminders arrive.** Check that **Studio Bot · 2 Notifier** is published. It runs every 5 minutes, so a reminder can be up to 5 minutes late.

**The Calendar button is missing, or the link gives "Not found".** Set the address and publish workflow 3:

```sql
SELECT studio.setup(calendar_url => 'https://YOUR-N8N-ADDRESS/webhook/studio-calendar');
```

**Start again from scratch (part 2B).** This deletes all data: `docker compose down -v`, then `docker compose up -d`.

**Something else.** [Open an issue](https://github.com/lunox-work/n8n-telegram-class-booking/issues) with the error text from the failed execution.

## 7. Updating

1. Get the new files (`git pull`, or download them again).
2. Run `db/install.sql` again. It replaces the functions and keeps your rooms, people and classes. Part 2B: `docker compose exec -T postgres psql -U studio -d studio < db/install.sql`.
3. If a workflow file changed, import the new file as a new workflow (as in part 2A, step 6). Unpublish the old workflow of the same name and delete it, then publish the new one. Importing into the old workflow would add the new nodes next to the old ones. Changes you made in the editor are not carried over, so note them first.
