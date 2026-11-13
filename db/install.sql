-- Studio bot: schema and logic for the n8n Telegram class-booking workflows.
--
-- Needs PostgreSQL 13 or newer. Safe to run again: tables are only created
-- when missing and every function is replaced, so upgrading is "run this file".
--
-- The rules that must never break live here, not in n8n:
--   * a room cannot hold two confirmed classes at once   (booking_room_free)
--   * a trainer cannot teach two confirmed classes at once (booking_trainer_free)
--   * who may do what (studio._actor and the checks in each function)
-- n8n calls one function per screen; each takes one jsonb argument and returns
-- jsonb, so the workflow never builds SQL from chat input.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS studio;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio.settings (
  singleton        boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  studio_name      text    NOT NULL DEFAULT 'Studio',
  timezone         text    NOT NULL DEFAULT 'UTC',
  opens            time    NOT NULL DEFAULT '06:00',
  closes           time    NOT NULL DEFAULT '22:00',
  closed_weekdays  integer[] NOT NULL DEFAULT '{}',          -- ISO: 1 = Monday ... 7 = Sunday
  slot_minutes     integer NOT NULL DEFAULT 30 CHECK (slot_minutes IN (15, 30, 60)),
  horizon_days     integer NOT NULL DEFAULT 60 CHECK (horizon_days BETWEEN 1 AND 365),
  reminder_minutes integer[] NOT NULL DEFAULT '{1440,60}',   -- minutes before a class starts
  digest_time      time    DEFAULT '07:00',                  -- NULL switches the morning summary off
  notify_admins    boolean NOT NULL DEFAULT true,            -- tell admins what trainers book, move, cancel
  bot_token        text,
  telegram_api     text    NOT NULL DEFAULT 'https://api.telegram.org',
  calendar_url     text,                                     -- public URL of the calendar-feed webhook
  calendar_token   text    NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  CONSTRAINT settings_hours CHECK (opens < closes)
);
INSERT INTO studio.settings DEFAULT VALUES ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS studio.person (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_id bigint NOT NULL UNIQUE,
  name        text   NOT NULL,
  username    text,
  role        text   NOT NULL DEFAULT 'trainer' CHECK (role IN ('admin', 'trainer')),
  status      text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'blocked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_by  bigint REFERENCES studio.person (id),
  decided_at  timestamptz
);

CREATE TABLE IF NOT EXISTS studio.room (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  capacity   integer CHECK (capacity > 0),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS room_name_key ON studio.room (lower(name));

CREATE TABLE IF NOT EXISTS studio.class_type (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  minutes    integer NOT NULL CHECK (minutes BETWEEN 15 AND 480),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS class_type_name_key ON studio.class_type (lower(name));

CREATE TABLE IF NOT EXISTS studio.booking (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id       bigint NOT NULL REFERENCES studio.room (id),
  trainer_id    bigint NOT NULL REFERENCES studio.person (id),
  class_type_id bigint NOT NULL REFERENCES studio.class_type (id),
  during        tstzrange NOT NULL,
  status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  series_id     uuid,                                   -- set when booked as a weekly series
  created_by    bigint NOT NULL REFERENCES studio.person (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  scheduled_at  timestamptz NOT NULL DEFAULT now(),     -- when the current time slot was chosen
  cancelled_by  bigint REFERENCES studio.person (id),
  cancelled_at  timestamptz,
  CONSTRAINT booking_during_valid CHECK (
    NOT isempty(during) AND lower_inc(during) AND NOT upper_inc(during)
    AND NOT lower_inf(during) AND NOT upper_inf(during)
  ),
  -- The two guarantees. A cancelled class stops blocking its slot, and because
  -- the check runs inside the database it holds for two taps in the same
  -- millisecond, for a second n8n worker, and for a manual UPDATE alike.
  CONSTRAINT booking_room_free
    EXCLUDE USING gist (room_id WITH =, during WITH &&) WHERE (status = 'confirmed'),
  CONSTRAINT booking_trainer_free
    EXCLUDE USING gist (trainer_id WITH =, during WITH &&) WHERE (status = 'confirmed')
);
CREATE INDEX IF NOT EXISTS booking_trainer_upcoming ON studio.booking (trainer_id, lower(during))
  WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS booking_series ON studio.booking (series_id) WHERE series_id IS NOT NULL;

-- Who did what to which class: the audit trail.
CREATE TABLE IF NOT EXISTS studio.booking_event (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id bigint NOT NULL REFERENCES studio.booking (id),
  actor_id   bigint NOT NULL REFERENCES studio.person (id),
  kind       text NOT NULL CHECK (kind IN ('booked', 'rescheduled', 'cancelled')),
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_event_booking ON studio.booking_event (booking_id);

-- Messages for people other than the one tapping: written in the same
-- transaction as the change that caused them, delivered by the workflows.
CREATE TABLE IF NOT EXISTS studio.outbox (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id  bigint NOT NULL REFERENCES studio.person (id),
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  attempts   integer NOT NULL DEFAULT 0,
  sent_at    timestamptz,
  failed_at  timestamptz,
  last_error text
);
CREATE INDEX IF NOT EXISTS outbox_waiting ON studio.outbox (id)
  WHERE sent_at IS NULL AND failed_at IS NULL;

-- starts_at is part of the key, so moving a class re-arms its reminders.
CREATE TABLE IF NOT EXISTS studio.reminder_sent (
  booking_id bigint NOT NULL REFERENCES studio.booking (id),
  minutes    integer NOT NULL,
  starts_at  timestamptz NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, minutes, starts_at)
);

CREATE TABLE IF NOT EXISTS studio.digest_sent (
  day       date   NOT NULL,
  person_id bigint NOT NULL REFERENCES studio.person (id),
  PRIMARY KEY (day, person_id)
);

-- Telegram resends an update when a webhook answer is slow; each is handled once.
CREATE TABLE IF NOT EXISTS studio.processed_update (
  update_id bigint PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now()
);

-- Only typed answers need remembering ("send me the room name"). Every button
-- flow carries its own state in the button, so there is nothing to go stale.
CREATE TABLE IF NOT EXISTS studio.chat_state (
  person_id bigint PRIMARY KEY REFERENCES studio.person (id),
  awaiting  text NOT NULL,
  data      jsonb NOT NULL DEFAULT '{}',
  at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Setup
-- ---------------------------------------------------------------------------

-- SELECT studio.setup(bot_token => '123:ABC', studio_name => 'Flex', timezone => 'Europe/Berlin');
-- Only the arguments you pass are changed.
CREATE OR REPLACE FUNCTION studio.setup(
  bot_token        text      DEFAULT NULL,
  studio_name      text      DEFAULT NULL,
  timezone         text      DEFAULT NULL,
  opens            time      DEFAULT NULL,
  closes           time      DEFAULT NULL,
  closed_weekdays  integer[] DEFAULT NULL,
  slot_minutes     integer   DEFAULT NULL,
  horizon_days     integer   DEFAULT NULL,
  reminder_minutes integer[] DEFAULT NULL,
  digest_time      time      DEFAULT NULL,
  notify_admins    boolean   DEFAULT NULL,
  calendar_url     text      DEFAULT NULL,
  telegram_api     text      DEFAULT NULL
) RETURNS text LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  cfg studio.settings;
BEGIN
  IF setup.timezone IS NOT NULL THEN
    PERFORM now() AT TIME ZONE setup.timezone;  -- raises on an unknown zone name
  END IF;
  UPDATE studio.settings s SET
    bot_token        = COALESCE(NULLIF(trim(setup.bot_token), ''), s.bot_token),
    studio_name      = COALESCE(NULLIF(trim(setup.studio_name), ''), s.studio_name),
    timezone         = COALESCE(setup.timezone, s.timezone),
    opens            = COALESCE(setup.opens, s.opens),
    closes           = COALESCE(setup.closes, s.closes),
    closed_weekdays  = COALESCE(setup.closed_weekdays, s.closed_weekdays),
    slot_minutes     = COALESCE(setup.slot_minutes, s.slot_minutes),
    horizon_days     = COALESCE(setup.horizon_days, s.horizon_days),
    reminder_minutes = COALESCE(setup.reminder_minutes, s.reminder_minutes),
    digest_time      = COALESCE(setup.digest_time, s.digest_time),
    notify_admins    = COALESCE(setup.notify_admins, s.notify_admins),
    calendar_url     = COALESCE(NULLIF(rtrim(trim(setup.calendar_url), '/'), ''), s.calendar_url),
    telegram_api     = COALESCE(NULLIF(rtrim(trim(setup.telegram_api), '/'), ''), s.telegram_api)
  RETURNING * INTO cfg;
  RETURN format('%s: %s, open %s-%s, %s-minute slots, bot token %s',
    cfg.studio_name, cfg.timezone, to_char(cfg.opens, 'HH24:MI'), to_char(cfg.closes, 'HH24:MI'),
    cfg.slot_minutes, CASE WHEN cfg.bot_token IS NULL THEN 'MISSING' ELSE 'set' END);
END $$;

-- ---------------------------------------------------------------------------
-- Helpers (names start with an underscore; n8n never calls these)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION studio._cfg() RETURNS studio.settings
LANGUAGE sql STABLE AS $$ SELECT * FROM studio.settings $$;

-- A refusal is an expected "no" (not allowed, slot gone). Public functions turn
-- it into {"ok": false, "error": "..."} so the bot can answer politely; any
-- other exception is a real failure and stops the n8n execution.
CREATE OR REPLACE FUNCTION studio._refuse(code text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', code USING ERRCODE = 'STU01';
END $$;

-- Role-based access starts here: every public function resolves the caller
-- from their Telegram id and gets nothing unless they are an active member.
CREATE OR REPLACE FUNCTION studio._actor(req jsonb, admin_only boolean DEFAULT false)
RETURNS studio.person LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
BEGIN
  SELECT * INTO me FROM studio.person
  WHERE telegram_id = (req ->> 'tg')::bigint AND status = 'active';
  IF NOT FOUND OR (admin_only AND me.role <> 'admin') THEN
    PERFORM studio._refuse('forbidden');
  END IF;
  RETURN me;
END $$;

CREATE OR REPLACE FUNCTION studio._hhmm(t timestamptz) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT to_char(t AT TIME ZONE s.timezone, 'HH24:MI') FROM studio.settings s
$$;

CREATE OR REPLACE FUNCTION studio._day(t timestamptz) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT to_char(t AT TIME ZONE s.timezone, 'YYYY-MM-DD') FROM studio.settings s
$$;

CREATE OR REPLACE FUNCTION studio._today() RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE s.timezone)::date FROM studio.settings s
$$;

-- One class as the bot shows it, from the point of view of one person.
CREATE OR REPLACE FUNCTION studio._booking(p_id bigint, viewer_id bigint, viewer_role text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', b.id,
    'class', ct.name,
    'minutes', (extract(epoch FROM upper(b.during) - lower(b.during)) / 60)::integer,
    'room', r.name,
    'room_id', r.id,
    'trainer', p.name,
    'trainer_id', p.id,
    'day', studio._day(lower(b.during)),
    'from', studio._hhmm(lower(b.during)),
    'to', studio._hhmm(upper(b.during)),
    'status', b.status,
    'mine', b.trainer_id = viewer_id,
    'upcoming', lower(b.during) > now(),
    'can_edit', b.status = 'confirmed' AND lower(b.during) > now()
                AND (viewer_role = 'admin' OR b.trainer_id = viewer_id),
    'following', (
      SELECT count(*) FROM studio.booking f
      WHERE b.series_id IS NOT NULL AND f.series_id = b.series_id
        AND f.status = 'confirmed' AND lower(f.during) > lower(b.during)
    )
  )
  FROM studio.booking b
  JOIN studio.class_type ct ON ct.id = b.class_type_id
  JOIN studio.room r ON r.id = b.room_id
  JOIN studio.person p ON p.id = b.trainer_id
  WHERE b.id = p_id
$$;

-- Every possible start time for a class of p_minutes in one room on one day,
-- with whether the room and the trainer are free. p_except leaves one booking
-- out of the check, which is what makes "move this class" see its own slot as
-- free.
CREATE OR REPLACE FUNCTION studio._slots(
  p_room bigint, p_day date, p_minutes integer, p_trainer bigint, p_except bigint DEFAULT NULL
) RETURNS TABLE (t time, starts timestamptz, ends timestamptz, room_free boolean, trainer_free boolean)
LANGUAGE sql STABLE AS $$
  SELECT
    g::time,
    x.starts,
    x.ends,
    NOT EXISTS (
      SELECT 1 FROM studio.booking b
      WHERE b.status = 'confirmed' AND b.room_id = p_room
        AND b.during && tstzrange(x.starts, x.ends) AND b.id IS DISTINCT FROM p_except
    ),
    NOT EXISTS (
      SELECT 1 FROM studio.booking b
      WHERE b.status = 'confirmed' AND b.trainer_id = p_trainer
        AND b.during && tstzrange(x.starts, x.ends) AND b.id IS DISTINCT FROM p_except
    )
  FROM studio.settings s
  CROSS JOIN LATERAL generate_series(
    p_day + s.opens,
    p_day + s.closes - make_interval(mins => p_minutes),
    make_interval(mins => s.slot_minutes)
  ) AS g
  CROSS JOIN LATERAL (
    SELECT g AT TIME ZONE s.timezone AS starts,
           (g AT TIME ZONE s.timezone) + make_interval(mins => p_minutes) AS ends
  ) AS x
  WHERE x.starts > now()
    AND p_day <= studio._today() + s.horizon_days
    AND NOT (extract(isodow FROM p_day)::integer = ANY (s.closed_weekdays))
$$;

-- The free windows of one room between two moments, as [{from, to}].
CREATE OR REPLACE FUNCTION studio._gaps(p_room bigint, p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH busy AS (
    SELECT greatest(lower(during), p_from) AS b_from, least(upper(during), p_to) AS b_to
    FROM studio.booking
    WHERE status = 'confirmed' AND room_id = p_room AND during && tstzrange(p_from, p_to)
  ),
  edges AS (
    SELECT lag(b_to, 1, p_from) OVER (ORDER BY b_from) AS g_from, b_from AS g_to FROM busy
    UNION ALL
    SELECT COALESCE((SELECT max(b_to) FROM busy), p_from), p_to
  )
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object('from', studio._hhmm(g_from), 'to', studio._hhmm(g_to)) ORDER BY g_from),
    '[]'::jsonb)
  FROM edges
  WHERE g_to > g_from
$$;

-- What a booking or a move is about: the class type, room and trainer, with
-- every permission and "does it still exist" check in one place.
CREATE OR REPLACE FUNCTION studio._plan(req jsonb, me studio.person) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  bk studio.booking;
  ct studio.class_type;
  rm studio.room;
  tr studio.person;
  v_class bigint;
  v_room bigint;
  v_trainer bigint;
  v_minutes integer;
BEGIN
  IF req ? 'booking' THEN
    SELECT * INTO bk FROM studio.booking WHERE id = (req ->> 'booking')::bigint;
    IF NOT FOUND THEN PERFORM studio._refuse('not_found'); END IF;
    IF me.role <> 'admin' AND bk.trainer_id <> me.id THEN PERFORM studio._refuse('forbidden'); END IF;
    IF bk.status <> 'confirmed' OR lower(bk.during) <= now() THEN PERFORM studio._refuse('closed'); END IF;
    v_class := bk.class_type_id;
    v_room := COALESCE(NULLIF(req ->> 'room', '')::bigint, bk.room_id);
    v_trainer := bk.trainer_id;
    v_minutes := (extract(epoch FROM upper(bk.during) - lower(bk.during)) / 60)::integer;
  ELSE
    v_class := NULLIF(req ->> 'class', '')::bigint;
    v_room := NULLIF(req ->> 'room', '')::bigint;
    v_trainer := COALESCE(NULLIF(req ->> 'trainer', '')::bigint, me.id);
    IF v_trainer <> me.id AND me.role <> 'admin' THEN PERFORM studio._refuse('forbidden'); END IF;
  END IF;

  SELECT * INTO ct FROM studio.class_type WHERE id = v_class;
  IF NOT FOUND OR (NOT ct.active AND bk.id IS NULL) THEN PERFORM studio._refuse('class_gone'); END IF;
  IF v_room IS NOT NULL THEN
    SELECT * INTO rm FROM studio.room WHERE id = v_room AND active;
    IF NOT FOUND THEN PERFORM studio._refuse('room_gone'); END IF;
  END IF;
  SELECT * INTO tr FROM studio.person WHERE id = v_trainer AND status = 'active';
  IF NOT FOUND THEN PERFORM studio._refuse('trainer_gone'); END IF;

  RETURN jsonb_build_object(
    'class', jsonb_build_object('id', ct.id, 'name', ct.name),
    'minutes', COALESCE(v_minutes, ct.minutes),
    'room', CASE WHEN rm.id IS NOT NULL THEN jsonb_build_object('id', rm.id, 'name', rm.name) END,
    'trainer', jsonb_build_object('id', tr.id, 'name', tr.name, 'self', tr.id = me.id),
    'booking', CASE WHEN bk.id IS NOT NULL THEN studio._booking(bk.id, me.id, me.role) END
  );
END $$;

-- Free start times as ["09:00", ...] plus how many were left out and why.
CREATE OR REPLACE FUNCTION studio._free_times(plan jsonb, p_day date, p_except bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'slots', COALESCE(jsonb_agg(to_char(t, 'HH24:MI') ORDER BY t) FILTER (WHERE room_free AND trainer_free), '[]'::jsonb),
    'trainer_busy', count(*) FILTER (WHERE room_free AND NOT trainer_free),
    'room_busy', count(*) FILTER (WHERE NOT room_free)
  )
  FROM studio._slots((plan #>> '{room,id}')::bigint, p_day, (plan ->> 'minutes')::integer,
                     (plan #>> '{trainer,id}')::bigint, p_except)
$$;

CREATE OR REPLACE FUNCTION studio._notify(p_person bigint, p_kind text, p_payload jsonb)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO studio.outbox (person_id, kind, payload) VALUES (p_person, p_kind, p_payload)
$$;

-- Tell the people a change concerns, never the person who made it: the trainer
-- when somebody else touched their class, and the admins when a trainer acted.
CREATE OR REPLACE FUNCTION studio._announce(
  p_kind text, p_booking bigint, me studio.person, extra jsonb DEFAULT '{}'
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  bk studio.booking;
  body jsonb;
BEGIN
  SELECT * INTO bk FROM studio.booking WHERE id = p_booking;
  body := extra || jsonb_build_object('booking', studio._booking(p_booking, 0, 'none'), 'actor', me.name);
  IF bk.trainer_id <> me.id THEN
    PERFORM studio._notify(bk.trainer_id, p_kind, body || '{"yours": true}');
  END IF;
  IF me.role = 'trainer' AND (SELECT notify_admins FROM studio.settings) THEN
    INSERT INTO studio.outbox (person_id, kind, payload)
    SELECT a.id, p_kind, body || '{"yours": false}'
    FROM studio.person a
    WHERE a.role = 'admin' AND a.status = 'active' AND a.id NOT IN (me.id, bk.trainer_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Public functions: one per branch of the n8n workflow
-- ---------------------------------------------------------------------------

-- First step for every Telegram update: drop duplicates, find or register the
-- sender, and hand back what the router needs.
CREATE OR REPLACE FUNCTION studio.begin(upd jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  cfg studio.settings := studio._cfg();
  sender jsonb := COALESCE(upd #> '{callback_query,from}', upd #> '{message,from}');
  chat jsonb := COALESCE(upd #> '{callback_query,message,chat}', upd #> '{message,chat}');
  me studio.person;
  st studio.chat_state;
  is_new boolean := false;
  bootstrap boolean;
BEGIN
  IF cfg.bot_token IS NULL THEN
    RAISE EXCEPTION 'Studio bot is not set up: run SELECT studio.setup(bot_token => ''<token from @BotFather>''); see the README';
  END IF;

  INSERT INTO studio.processed_update (update_id) VALUES ((upd ->> 'update_id')::bigint)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skip', 'duplicate update');
  END IF;
  IF sender IS NULL OR chat ->> 'type' IS DISTINCT FROM 'private'
     OR COALESCE((sender ->> 'is_bot')::boolean, false) THEN
    RETURN jsonb_build_object('skip', 'not a private chat with a person');
  END IF;

  SELECT * INTO me FROM studio.person WHERE telegram_id = (sender ->> 'id')::bigint;
  IF NOT FOUND THEN
    -- The first person to talk to a fresh bot becomes its admin; everyone
    -- after that waits for an admin to let them in.
    PERFORM pg_advisory_xact_lock(hashtext('studio.person.bootstrap'));
    bootstrap := NOT EXISTS (SELECT 1 FROM studio.person WHERE role = 'admin' AND status = 'active');
    INSERT INTO studio.person (telegram_id, name, username, role, status)
    VALUES (
      (sender ->> 'id')::bigint,
      left(COALESCE(NULLIF(trim(concat_ws(' ', sender ->> 'first_name', sender ->> 'last_name')), ''), 'Unnamed'), 60),
      sender ->> 'username',
      CASE WHEN bootstrap THEN 'admin' ELSE 'trainer' END,
      CASE WHEN bootstrap THEN 'active' ELSE 'pending' END
    )
    RETURNING * INTO me;
    is_new := true;
    IF NOT bootstrap THEN
      INSERT INTO studio.outbox (person_id, kind, payload)
      SELECT a.id, 'access_request',
             jsonb_build_object('person_id', me.id, 'name', me.name, 'username', me.username)
      FROM studio.person a WHERE a.role = 'admin' AND a.status = 'active';
    END IF;
  ELSIF me.username IS DISTINCT FROM (sender ->> 'username') THEN
    UPDATE studio.person SET username = sender ->> 'username' WHERE id = me.id;
  END IF;

  -- A button tap or a command abandons any question the bot was waiting on.
  IF upd ? 'callback_query' OR COALESCE(upd #>> '{message,text}', '') LIKE '/%' THEN
    DELETE FROM studio.chat_state WHERE person_id = me.id;
  ELSE
    SELECT * INTO st FROM studio.chat_state
    WHERE person_id = me.id AND at > now() - interval '15 minutes';
  END IF;

  RETURN jsonb_build_object(
    'api', cfg.telegram_api || '/bot' || cfg.bot_token,
    'me', jsonb_build_object('id', me.id, 'tg', me.telegram_id, 'name', me.name,
                             'role', me.role, 'status', me.status, 'is_new', is_new),
    'studio', jsonb_build_object(
      'name', cfg.studio_name,
      'calendar', cfg.calendar_url IS NOT NULL,
      'rooms', (SELECT count(*) FROM studio.room WHERE active),
      'classes', (SELECT count(*) FROM studio.class_type WHERE active)),
    'today', to_char(studio._today(), 'YYYY-MM-DD'),
    'awaiting', CASE WHEN st.person_id IS NOT NULL
                     THEN jsonb_build_object('kind', st.awaiting, 'data', st.data) END
  );
END $$;

-- One day across all rooms: the classes and the free windows.
CREATE OR REPLACE FUNCTION studio.schedule(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  cfg studio.settings := studio._cfg();
  d date := COALESCE(NULLIF(req ->> 'day', '')::date, studio._today());
  day_from timestamptz := d::timestamp AT TIME ZONE cfg.timezone;
  day_to timestamptz := (d + 1)::timestamp AT TIME ZONE cfg.timezone;
  open_from timestamptz := (d + cfg.opens) AT TIME ZONE cfg.timezone;
  open_to timestamptz := (d + cfg.closes) AT TIME ZONE cfg.timezone;
  is_closed boolean := extract(isodow FROM d)::integer = ANY (cfg.closed_weekdays);
  slot interval := make_interval(mins => cfg.slot_minutes);
  rooms jsonb;
BEGIN
  me := studio._actor(req);
  -- Today, free time starts at the next slot boundary, not at opening time.
  IF now() > open_from THEN
    open_from := open_from + ceil(extract(epoch FROM now() - open_from) / extract(epoch FROM slot)) * slot;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.name), '[]'::jsonb) INTO rooms
  FROM (
    SELECT rm.id, rm.name, rm.capacity,
      COALESCE((
        SELECT jsonb_agg(studio._booking(b.id, me.id, me.role) ORDER BY lower(b.during))
        FROM studio.booking b
        WHERE b.room_id = rm.id AND b.status = 'confirmed' AND b.during && tstzrange(day_from, day_to)
      ), '[]'::jsonb) AS classes,
      CASE WHEN is_closed OR open_from >= open_to THEN '[]'::jsonb
           ELSE studio._gaps(rm.id, open_from, open_to) END AS free
    FROM studio.room rm
    WHERE rm.active
  ) AS x;

  RETURN jsonb_build_object(
    'ok', true,
    'day', to_char(d, 'YYYY-MM-DD'),
    'opens', to_char(cfg.opens, 'HH24:MI'),
    'closes', to_char(cfg.closes, 'HH24:MI'),
    'closed', is_closed,
    'past', d < studio._today(),
    'bookable', d >= studio._today() AND d <= studio._today() + cfg.horizon_days AND NOT is_closed,
    'rooms', rooms);
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- What can be picked: class types, rooms and, for admins, trainers.
CREATE OR REPLACE FUNCTION studio.options(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  plan jsonb;
BEGIN
  me := studio._actor(req);
  IF req ? 'booking' THEN
    plan := studio._plan(req - 'room', me);
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'plan', plan,
    'classes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'minutes', minutes) ORDER BY lower(name)), '[]'::jsonb)
                FROM studio.class_type WHERE active),
    'rooms', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'capacity', capacity) ORDER BY lower(name)), '[]'::jsonb)
              FROM studio.room WHERE active),
    'trainers', CASE WHEN me.role = 'admin' THEN
                  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'self', id = me.id) ORDER BY lower(name)), '[]'::jsonb)
                   FROM studio.person WHERE status = 'active')
                ELSE '[]'::jsonb END);
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- A week of days with how many start times are still free on each.
CREATE OR REPLACE FUNCTION studio.days(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  cfg studio.settings := studio._cfg();
  plan jsonb;
  today date := studio._today();
  last_day date := today + cfg.horizon_days;
  week integer := greatest(COALESCE(NULLIF(req ->> 'week', '')::integer, 0), 0);
  first_day date := today + week * 7;
  days jsonb;
BEGIN
  me := studio._actor(req);
  plan := studio._plan(req, me);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'day', to_char(d, 'YYYY-MM-DD'),
           'free', (SELECT count(*) FROM studio._slots(
                      (plan #>> '{room,id}')::bigint, d::date, (plan ->> 'minutes')::integer,
                      (plan #>> '{trainer,id}')::bigint, NULLIF(req ->> 'booking', '')::bigint) s
                    WHERE s.room_free AND s.trainer_free)
         ) ORDER BY d), '[]'::jsonb)
  INTO days
  FROM generate_series(first_day::timestamp, least(first_day + 6, last_day)::timestamp, interval '1 day') AS d;

  RETURN jsonb_build_object('ok', true, 'plan', plan, 'days', days, 'week', week,
                            'more', first_day + 7 <= last_day);
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- The free start times on one day.
CREATE OR REPLACE FUNCTION studio.slots(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  plan jsonb;
BEGIN
  me := studio._actor(req);
  plan := studio._plan(req, me);
  RETURN jsonb_build_object('ok', true, 'plan', plan, 'day', req ->> 'day')
         || studio._free_times(plan, (req ->> 'day')::date, NULLIF(req ->> 'booking', '')::bigint);
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- The confirmation card: everything about the choice, and whether it is still free.
CREATE OR REPLACE FUNCTION studio.preview(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  plan jsonb;
  s record;
BEGIN
  me := studio._actor(req);
  plan := studio._plan(req, me);
  SELECT * INTO s FROM studio._slots(
    (plan #>> '{room,id}')::bigint, (req ->> 'day')::date, (plan ->> 'minutes')::integer,
    (plan #>> '{trainer,id}')::bigint, NULLIF(req ->> 'booking', '')::bigint)
  WHERE t = (req ->> 'time')::time;
  IF NOT FOUND THEN PERFORM studio._refuse('bad_slot'); END IF;

  RETURN jsonb_build_object(
    'ok', true, 'plan', plan, 'day', req ->> 'day',
    'from', studio._hhmm(s.starts), 'to', studio._hhmm(s.ends),
    'free', s.room_free AND s.trainer_free,
    'why', CASE WHEN NOT s.room_free THEN 'room' WHEN NOT s.trainer_free THEN 'trainer' END,
    'is_admin', me.role = 'admin');
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- Book one class, or the same slot for several weeks running.
--
-- There is no "check, then insert" here. The insert is attempted and the
-- exclusion constraints decide, so two people confirming the same slot at the
-- same instant cannot both win. The loser gets the fresh list of free times
-- for the same room and day, so the chat can offer them straight away.
CREATE OR REPLACE FUNCTION studio.book(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  cfg studio.settings := studio._cfg();
  plan jsonb;
  v_room bigint;
  v_trainer bigint;
  v_class bigint;
  v_minutes integer;
  v_day date := (req ->> 'day')::date;
  v_time time := (req ->> 'time')::time;
  weeks integer := least(greatest(COALESCE(NULLIF(req ->> 'repeat', '')::integer, 1), 1), 12);
  series uuid := CASE WHEN weeks > 1 THEN gen_random_uuid() END;
  d date;
  starts timestamptz;
  span tstzrange;
  new_id bigint;
  first_id bigint;
  broken text;
  first_why text;
  booked jsonb := '[]';
  skipped jsonb := '[]';
  fresh integer := 0;
BEGIN
  me := studio._actor(req);
  plan := studio._plan(req, me);
  v_room := (plan #>> '{room,id}')::bigint;
  v_trainer := (plan #>> '{trainer,id}')::bigint;
  v_class := (plan #>> '{class,id}')::bigint;
  v_minutes := (plan ->> 'minutes')::integer;
  IF v_room IS NULL THEN PERFORM studio._refuse('bad_slot'); END IF;
  -- The first date must be a real, future, on-the-grid slot inside opening hours.
  IF NOT EXISTS (SELECT 1 FROM studio._slots(v_room, v_day, v_minutes, v_trainer) WHERE t = v_time) THEN
    PERFORM studio._refuse('bad_slot');
  END IF;

  FOR i IN 0 .. weeks - 1 LOOP
    d := v_day + i * 7;
    starts := (d + v_time) AT TIME ZONE cfg.timezone;
    span := tstzrange(starts, starts + make_interval(mins => v_minutes));
    IF extract(isodow FROM d)::integer = ANY (cfg.closed_weekdays) THEN
      skipped := skipped || jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'why', 'closed');
      CONTINUE;
    END IF;
    BEGIN
      INSERT INTO studio.booking (room_id, trainer_id, class_type_id, during, series_id, created_by)
      VALUES (v_room, v_trainer, v_class, span, series, me.id)
      RETURNING id INTO new_id;
      INSERT INTO studio.booking_event (booking_id, actor_id, kind, detail)
      VALUES (new_id, me.id, 'booked', jsonb_build_object('weeks', weeks));
      booked := booked || studio._booking(new_id, me.id, me.role);
      first_id := COALESCE(first_id, new_id);
      fresh := fresh + 1;
    EXCEPTION WHEN exclusion_violation THEN
      GET STACKED DIAGNOSTICS broken = CONSTRAINT_NAME;
      -- A second tap on "Book it" finds its own booking: report it as done.
      SELECT id INTO new_id FROM studio.booking
      WHERE room_id = v_room AND trainer_id = v_trainer AND class_type_id = v_class
        AND during = span AND status = 'confirmed';
      IF FOUND THEN
        booked := booked || studio._booking(new_id, me.id, me.role);
      ELSE
        first_why := COALESCE(first_why, CASE broken WHEN 'booking_trainer_free' THEN 'trainer' ELSE 'room' END);
        skipped := skipped || jsonb_build_object(
          'day', to_char(d, 'YYYY-MM-DD'),
          'why', CASE broken WHEN 'booking_trainer_free' THEN 'trainer' ELSE 'room' END);
      END IF;
    END;
  END LOOP;

  IF jsonb_array_length(booked) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'taken', 'why', COALESCE(first_why, 'room'),
                              'plan', plan, 'day', req ->> 'day', 'time', to_char(v_time, 'HH24:MI'))
           || studio._free_times(plan, v_day);
  END IF;

  IF fresh > 0 THEN
    PERFORM studio._announce('booked', first_id, me, jsonb_build_object('count', fresh));
  END IF;
  RETURN jsonb_build_object('ok', true, 'booked', booked, 'skipped', skipped, 'weeks', weeks);
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- Upcoming classes of the caller, a page at a time.
CREATE OR REPLACE FUNCTION studio.bookings(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  page integer := greatest(COALESCE(NULLIF(req ->> 'page', '')::integer, 0), 0);
  per_page CONSTANT integer := 8;
  total integer;
  items jsonb;
BEGIN
  me := studio._actor(req);
  SELECT count(*) INTO total FROM studio.booking
  WHERE trainer_id = me.id AND status = 'confirmed' AND upper(during) > now();

  SELECT COALESCE(jsonb_agg(studio._booking(x.id, me.id, me.role) ORDER BY x.starts), '[]'::jsonb) INTO items
  FROM (
    SELECT id, lower(during) AS starts FROM studio.booking
    WHERE trainer_id = me.id AND status = 'confirmed' AND upper(during) > now()
    ORDER BY lower(during) LIMIT per_page OFFSET page * per_page
  ) AS x;

  RETURN jsonb_build_object('ok', true, 'items', items, 'page', page, 'total', total,
                            'more', total > (page + 1) * per_page);
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- One class in full.
CREATE OR REPLACE FUNCTION studio.booking_details(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  item jsonb;
BEGIN
  me := studio._actor(req);
  item := studio._booking((req ->> 'id')::bigint, me.id, me.role);
  IF item IS NULL THEN PERFORM studio._refuse('not_found'); END IF;
  RETURN jsonb_build_object('ok', true, 'booking', item);
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- Cancel one class, or it and every later class of its weekly series.
CREATE OR REPLACE FUNCTION studio.cancel(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  bk studio.booking;
  ids bigint[];
  before jsonb;
BEGIN
  me := studio._actor(req);
  SELECT * INTO bk FROM studio.booking WHERE id = (req ->> 'id')::bigint FOR UPDATE;
  IF NOT FOUND THEN PERFORM studio._refuse('not_found'); END IF;
  IF me.role <> 'admin' AND bk.trainer_id <> me.id THEN PERFORM studio._refuse('forbidden'); END IF;
  before := studio._booking(bk.id, me.id, me.role);
  IF bk.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'booking', before, 'count', 0, 'already', true);
  END IF;
  IF lower(bk.during) <= now() THEN PERFORM studio._refuse('closed'); END IF;

  SELECT array_agg(id ORDER BY lower(during)) INTO ids FROM studio.booking
  WHERE status = 'confirmed' AND (
    id = bk.id
    OR (COALESCE((req ->> 'following')::boolean, false) AND bk.series_id IS NOT NULL
        AND series_id = bk.series_id AND lower(during) > lower(bk.during)));

  UPDATE studio.booking SET status = 'cancelled', cancelled_by = me.id, cancelled_at = now()
  WHERE id = ANY (ids);
  INSERT INTO studio.booking_event (booking_id, actor_id, kind)
  SELECT unnest(ids), me.id, 'cancelled';

  PERFORM studio._announce('cancelled', bk.id, me, jsonb_build_object('count', cardinality(ids)));
  RETURN jsonb_build_object('ok', true, 'booking', before || '{"status": "cancelled", "can_edit": false}',
                            'count', cardinality(ids));
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- Move a class to another time and, if wanted, another room.
--
-- One UPDATE: the old slot is released and the new one taken in the same
-- statement, so the class is never in two places and never in none.
CREATE OR REPLACE FUNCTION studio.reschedule(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  cfg studio.settings := studio._cfg();
  plan jsonb;
  bk_id bigint := (req ->> 'booking')::bigint;
  v_room bigint;
  v_minutes integer;
  v_day date := (req ->> 'day')::date;
  v_time time := (req ->> 'time')::time;
  starts timestamptz := (v_day + v_time) AT TIME ZONE cfg.timezone;
  span tstzrange;
  was jsonb;
  bk studio.booking;
  broken text;
BEGIN
  me := studio._actor(req);
  plan := studio._plan(req, me);
  v_room := (plan #>> '{room,id}')::bigint;
  v_minutes := (plan ->> 'minutes')::integer;
  span := tstzrange(starts, starts + make_interval(mins => v_minutes));
  was := plan -> 'booking';
  SELECT * INTO bk FROM studio.booking WHERE id = bk_id FOR UPDATE;
  IF bk.room_id = v_room AND bk.during = span THEN
    RETURN jsonb_build_object('ok', true, 'booking', was, 'was', was, 'already', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM studio._slots(v_room, v_day, v_minutes, bk.trainer_id, bk_id) WHERE t = v_time) THEN
    PERFORM studio._refuse('bad_slot');
  END IF;

  BEGIN
    UPDATE studio.booking SET room_id = v_room, during = span, scheduled_at = now()
    WHERE id = bk_id AND status = 'confirmed';
  EXCEPTION WHEN exclusion_violation THEN
    GET STACKED DIAGNOSTICS broken = CONSTRAINT_NAME;
    RETURN jsonb_build_object('ok', false, 'error', 'taken',
                              'why', CASE broken WHEN 'booking_trainer_free' THEN 'trainer' ELSE 'room' END,
                              'plan', plan, 'day', req ->> 'day', 'time', to_char(v_time, 'HH24:MI'))
           || studio._free_times(plan, v_day, bk_id);
  END;

  INSERT INTO studio.booking_event (booking_id, actor_id, kind, detail)
  VALUES (bk_id, me.id, 'rescheduled', jsonb_build_object('was', was));
  PERFORM studio._announce('moved', bk_id, me, jsonb_build_object('was', was));
  RETURN jsonb_build_object('ok', true, 'booking', studio._booking(bk_id, me.id, me.role), 'was', was);
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- Admins: who has access, and with which role.
--   op = list | view | set (action = trainer | admin | block)
CREATE OR REPLACE FUNCTION studio.people(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  op text := COALESCE(req ->> 'op', 'list');
  action text := req ->> 'action';
  target studio.person;
  note text;
BEGIN
  me := studio._actor(req, admin_only => true);
  IF op = 'list' THEN
    RETURN jsonb_build_object('ok', true, 'people', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'username', username,
                                                   'role', role, 'status', status, 'self', id = me.id)
                                ORDER BY (status = 'pending') DESC, (status = 'blocked'), lower(name)), '[]'::jsonb)
      FROM studio.person));
  END IF;

  SELECT * INTO target FROM studio.person WHERE id = (req ->> 'id')::bigint FOR UPDATE;
  IF NOT FOUND THEN PERFORM studio._refuse('not_found'); END IF;

  IF op = 'set' THEN
    IF action IS NULL OR action NOT IN ('trainer', 'admin', 'block') THEN PERFORM studio._refuse('not_found'); END IF;
    -- The studio must always keep one admin who can undo a mistake.
    IF target.role = 'admin' AND target.status = 'active' AND action <> 'admin'
       AND NOT EXISTS (SELECT 1 FROM studio.person
                       WHERE role = 'admin' AND status = 'active' AND id <> target.id) THEN
      PERFORM studio._refuse('last_admin');
    END IF;

    IF action = 'block' THEN
      UPDATE studio.person SET status = 'blocked', decided_by = me.id, decided_at = now()
      WHERE id = target.id AND status <> 'blocked';
      note := 'blocked';
    ELSE
      UPDATE studio.person SET role = action, status = 'active', decided_by = me.id, decided_at = now()
      WHERE id = target.id AND (role <> action OR status <> 'active');
      IF FOUND AND target.id <> me.id THEN
        PERFORM studio._notify(target.id, 'access_granted',
          jsonb_build_object('role', action, 'first_time', target.status <> 'active'));
      END IF;
      note := action;
    END IF;
    SELECT * INTO target FROM studio.person WHERE id = target.id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'note', note, 'person', jsonb_build_object(
    'id', target.id, 'name', target.name, 'username', target.username, 'role', target.role,
    'status', target.status, 'self', target.id = me.id,
    'upcoming', (SELECT count(*) FROM studio.booking
                 WHERE trainer_id = target.id AND status = 'confirmed' AND lower(during) > now())));
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- Admins: rooms and class types.
--   op = rooms | room_toggle | classes | class_toggle | ask | input
-- "ask" remembers which typed answer the bot is waiting for; "input" applies it.
CREATE OR REPLACE FUNCTION studio.manage(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  op text := COALESCE(req ->> 'op', '');
  st studio.chat_state;
  list text;
  typed text := trim(COALESCE(req ->> 'text', ''));
  v_name text;
  v_number integer;
  note text;
BEGIN
  me := studio._actor(req, admin_only => true);
  IF op = 'ask' THEN
    INSERT INTO studio.chat_state (person_id, awaiting, data)
    VALUES (me.id, req ->> 'awaiting', jsonb_build_object('id', req -> 'id'))
    ON CONFLICT (person_id) DO UPDATE SET awaiting = EXCLUDED.awaiting, data = EXCLUDED.data, at = now();
    RETURN jsonb_build_object('ok', true, 'asking', req ->> 'awaiting',
      'current', CASE req ->> 'awaiting'
                   WHEN 'room_rename' THEN (SELECT name FROM studio.room WHERE id = (req ->> 'id')::bigint)
                 END);
  END IF;

  IF op = 'input' THEN
    SELECT * INTO st FROM studio.chat_state WHERE person_id = me.id;
    IF NOT FOUND THEN PERFORM studio._refuse('not_found'); END IF;
    -- "Name" or "Name, 20": the part after the last comma is the number.
    v_name := trim(regexp_replace(typed, ',\s*\d{1,4}\s*$', ''));
    v_number := NULLIF(substring(typed FROM ',\s*(\d{1,4})\s*$'), '')::integer;
    IF length(v_name) NOT BETWEEN 1 AND 40 OR v_name ~ '[\n\r]' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_text', 'asking', st.awaiting);
    END IF;
    BEGIN
      IF st.awaiting = 'room_new' THEN
        IF v_number = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_text', 'asking', st.awaiting); END IF;
        INSERT INTO studio.room (name, capacity) VALUES (v_name, v_number);
        list := 'rooms'; note := 'added';
      ELSIF st.awaiting = 'room_rename' THEN
        UPDATE studio.room SET name = v_name, capacity = COALESCE(v_number, capacity)
        WHERE id = (st.data ->> 'id')::bigint;
        list := 'rooms'; note := 'renamed';
      ELSIF st.awaiting = 'class_new' THEN
        IF v_number IS NULL OR v_number NOT BETWEEN 15 AND 480 THEN
          RETURN jsonb_build_object('ok', false, 'error', 'bad_text', 'asking', st.awaiting);
        END IF;
        INSERT INTO studio.class_type (name, minutes) VALUES (v_name, v_number);
        list := 'classes'; note := 'added';
      ELSE
        PERFORM studio._refuse('not_found');
      END IF;
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('ok', false, 'error', 'duplicate', 'asking', st.awaiting, 'name', v_name);
    END;
    DELETE FROM studio.chat_state WHERE person_id = me.id;
  ELSIF op = 'room_toggle' THEN
    UPDATE studio.room SET active = NOT active WHERE id = (req ->> 'id')::bigint;
    list := 'rooms';
  ELSIF op = 'class_toggle' THEN
    UPDATE studio.class_type SET active = NOT active WHERE id = (req ->> 'id')::bigint;
    list := 'classes';
  ELSIF op IN ('rooms', 'classes') THEN
    list := op;
  ELSE
    PERFORM studio._refuse('not_found');
  END IF;

  IF list = 'rooms' THEN
    RETURN jsonb_build_object('ok', true, 'list', 'rooms', 'note', note, 'rooms', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', r.id, 'name', r.name, 'capacity', r.capacity, 'active', r.active,
               'upcoming', (SELECT count(*) FROM studio.booking b
                            WHERE b.room_id = r.id AND b.status = 'confirmed' AND lower(b.during) > now()))
             ORDER BY r.active DESC, lower(r.name)), '[]'::jsonb)
      FROM studio.room r));
  END IF;
  RETURN jsonb_build_object('ok', true, 'list', 'classes', 'note', note, 'classes', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'minutes', minutes, 'active', active)
                              ORDER BY active DESC, lower(name)), '[]'::jsonb)
    FROM studio.class_type));
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- Links to the read-only calendar feed, for Google, Apple or Outlook calendars.
CREATE OR REPLACE FUNCTION studio.calendar(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  me studio.person;
  cfg studio.settings := studio._cfg();
  base text;
BEGIN
  me := studio._actor(req);
  IF cfg.calendar_url IS NULL THEN PERFORM studio._refuse('no_calendar'); END IF;
  base := cfg.calendar_url || '?token=' || cfg.calendar_token;
  RETURN jsonb_build_object('ok', true,
    'mine', base || '&trainer=' || me.id,
    'studio', base,
    'rooms', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', name, 'url', base || '&room=' || id)
                                        ORDER BY lower(name)), '[]'::jsonb)
              FROM studio.room WHERE active));
EXCEPTION WHEN SQLSTATE 'STU01' THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- ---------------------------------------------------------------------------
-- Calendar feed (iCalendar): Postgres stays the source of truth, calendars read
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION studio._ics_text(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(replace(replace(COALESCE(t, ''), E'\\', E'\\\\'), ';', E'\\;'), ',', E'\\,'), E'\n', E'\\n')
$$;

CREATE OR REPLACE FUNCTION studio._ics_time(t timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT to_char(t AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"')
$$;

-- req = the webhook's query string: token, and optionally room or trainer.
CREATE OR REPLACE FUNCTION studio.ics(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  cfg studio.settings := studio._cfg();
  events text;
BEGIN
  IF COALESCE(req ->> 'token', '') <> cfg.calendar_token
     OR COALESCE(req ->> 'room', '0') !~ '^\d{1,18}$'
     OR COALESCE(req ->> 'trainer', '0') !~ '^\d{1,18}$' THEN
    RETURN jsonb_build_object('ok', false, 'body', 'Not found');
  END IF;

  SELECT string_agg(concat_ws(E'\r\n',
           'BEGIN:VEVENT',
           'UID:class-' || b.id || '@studio-bot',
           'DTSTAMP:' || studio._ics_time(b.scheduled_at),
           'DTSTART:' || studio._ics_time(lower(b.during)),
           'DTEND:' || studio._ics_time(upper(b.during)),
           'SUMMARY:' || studio._ics_text(ct.name || ' - ' || p.name),
           'LOCATION:' || studio._ics_text(r.name),
           'SEQUENCE:' || (SELECT count(*) FROM studio.booking_event e
                           WHERE e.booking_id = b.id AND e.kind = 'rescheduled'),
           'END:VEVENT'), E'\r\n' ORDER BY lower(b.during))
  INTO events
  FROM studio.booking b
  JOIN studio.class_type ct ON ct.id = b.class_type_id
  JOIN studio.room r ON r.id = b.room_id
  JOIN studio.person p ON p.id = b.trainer_id
  WHERE b.status = 'confirmed'
    AND lower(b.during) > now() - interval '30 days'
    AND (req ->> 'room' IS NULL OR b.room_id = (req ->> 'room')::bigint)
    AND (req ->> 'trainer' IS NULL OR b.trainer_id = (req ->> 'trainer')::bigint);

  RETURN jsonb_build_object('ok', true, 'body', concat_ws(E'\r\n',
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//n8n-telegram-class-booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' || studio._ics_text(cfg.studio_name),
    events,
    'END:VCALENDAR') || E'\r\n');
END $$;

-- ---------------------------------------------------------------------------
-- Notifications: reminders, morning summary, and delivery of the outbox
-- ---------------------------------------------------------------------------

-- Queue whatever has come due, then hand out a batch of messages to send.
-- A claimed message that is never reported back is handed out again after
-- five minutes, so a crashed execution does not lose it.
CREATE OR REPLACE FUNCTION studio.claim_due(req jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  cfg studio.settings := studio._cfg();
  today date := studio._today();
  local_time time := (now() AT TIME ZONE cfg.timezone)::time;
  batch integer := least(greatest(COALESCE(NULLIF(req ->> 'limit', '')::integer, 25), 1), 100);
  messages jsonb;
BEGIN
  IF cfg.bot_token IS NULL THEN
    RAISE EXCEPTION 'Studio bot is not set up: run SELECT studio.setup(bot_token => ''<token from @BotFather>''); see the README';
  END IF;

  -- Reminders. One that was already due when the slot was chosen is skipped
  -- (nobody needs "tomorrow!" for a class they booked an hour ago), and when
  -- several are due at once only the nearest one is sent.
  WITH due AS (
    INSERT INTO studio.reminder_sent (booking_id, minutes, starts_at)
    SELECT b.id, m, lower(b.during)
    FROM studio.booking b
    CROSS JOIN unnest(cfg.reminder_minutes) AS m
    JOIN studio.person p ON p.id = b.trainer_id AND p.status = 'active'
    WHERE b.status = 'confirmed'
      AND lower(b.during) > now()
      AND lower(b.during) - make_interval(mins => m) <= now()
      AND b.scheduled_at <= lower(b.during) - make_interval(mins => m)
    ON CONFLICT DO NOTHING
    RETURNING booking_id, minutes
  )
  INSERT INTO studio.outbox (person_id, kind, payload)
  SELECT b.trainer_id, 'reminder',
         jsonb_build_object('booking', studio._booking(b.id, b.trainer_id, 'trainer'), 'minutes', n.minutes)
  FROM (SELECT booking_id, min(minutes) AS minutes FROM due GROUP BY booking_id) AS n
  JOIN studio.booking b ON b.id = n.booking_id;

  -- Morning summary, once a day, for everyone who teaches today.
  IF cfg.digest_time IS NOT NULL AND local_time >= cfg.digest_time
     AND local_time < cfg.digest_time + interval '3 hours' THEN
    WITH teaching AS (
      INSERT INTO studio.digest_sent (day, person_id)
      SELECT DISTINCT today, b.trainer_id
      FROM studio.booking b
      JOIN studio.person p ON p.id = b.trainer_id AND p.status = 'active'
      WHERE b.status = 'confirmed' AND lower(b.during) > now() AND studio._day(lower(b.during)) = to_char(today, 'YYYY-MM-DD')
      ON CONFLICT DO NOTHING
      RETURNING person_id
    )
    INSERT INTO studio.outbox (person_id, kind, payload)
    SELECT t.person_id, 'digest', jsonb_build_object(
      'day', to_char(today, 'YYYY-MM-DD'),
      'classes', (SELECT jsonb_agg(studio._booking(b.id, t.person_id, 'trainer') ORDER BY lower(b.during))
                  FROM studio.booking b
                  WHERE b.trainer_id = t.person_id AND b.status = 'confirmed' AND lower(b.during) > now()
                    AND studio._day(lower(b.during)) = to_char(today, 'YYYY-MM-DD')))
    FROM teaching t;
  END IF;

  -- Nothing is sent to people who lost access.
  UPDATE studio.outbox o SET failed_at = now(), last_error = 'recipient is not active'
  FROM studio.person p
  WHERE p.id = o.person_id AND p.status <> 'active' AND o.kind <> 'access_granted'
    AND o.sent_at IS NULL AND o.failed_at IS NULL;

  WITH picked AS (
    SELECT id FROM studio.outbox
    WHERE sent_at IS NULL AND failed_at IS NULL
      AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
    ORDER BY id LIMIT batch
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE studio.outbox o SET claimed_at = now(), attempts = attempts + 1
    FROM picked WHERE o.id = picked.id
    RETURNING o.id, o.person_id, o.kind, o.payload
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'chat_id', p.telegram_id, 'kind', c.kind,
                                               'payload', c.payload) ORDER BY c.id), '[]'::jsonb)
  INTO messages
  FROM claimed c JOIN studio.person p ON p.id = c.person_id;

  DELETE FROM studio.processed_update WHERE at < now() - interval '3 days';
  DELETE FROM studio.chat_state WHERE at < now() - interval '1 day';

  RETURN jsonb_build_object(
    'api', cfg.telegram_api || '/bot' || cfg.bot_token,
    'studio', jsonb_build_object('name', cfg.studio_name),
    'today', to_char(today, 'YYYY-MM-DD'),
    'messages', messages);
END $$;

-- req = {"results": [{"id": 1, "ok": true}, {"id": 2, "ok": false, "error": "..."}]}
-- A failed message is retried by a later run, up to five attempts, unless
-- Telegram says the person can no longer be reached.
CREATE OR REPLACE FUNCTION studio.record_deliveries(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  sent integer;
  failed integer;
BEGIN
  UPDATE studio.outbox o SET sent_at = now(), last_error = NULL
  FROM jsonb_array_elements(COALESCE(req -> 'results', '[]')) AS r
  WHERE o.id = (r ->> 'id')::bigint AND (r ->> 'ok')::boolean AND o.sent_at IS NULL;
  GET DIAGNOSTICS sent = ROW_COUNT;

  UPDATE studio.outbox o SET
    last_error = left(r ->> 'error', 300),
    failed_at = CASE WHEN o.attempts >= 5
                       OR (r ->> 'error') ~* 'blocked by the user|user is deactivated|chat not found'
                     THEN now() END
  FROM jsonb_array_elements(COALESCE(req -> 'results', '[]')) AS r
  WHERE o.id = (r ->> 'id')::bigint AND NOT (r ->> 'ok')::boolean AND o.sent_at IS NULL;
  GET DIAGNOSTICS failed = ROW_COUNT;

  RETURN jsonb_build_object('sent', sent, 'failed', failed);
END $$;

-- Called by the error workflow: tell the admins that an execution failed.
-- The same message is not repeated within ten minutes.
CREATE OR REPLACE FUNCTION studio.alert(req jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  body jsonb := jsonb_build_object(
    'workflow', left(COALESCE(req ->> 'workflow', 'a workflow'), 80),
    'node', left(COALESCE(req ->> 'node', ''), 80),
    'message', left(COALESCE(req ->> 'message', 'unknown error'), 500),
    'url', req ->> 'url');
  queued integer;
BEGIN
  INSERT INTO studio.outbox (person_id, kind, payload)
  SELECT a.id, 'alert', body
  FROM studio.person a
  WHERE a.role = 'admin' AND a.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM studio.outbox o
      WHERE o.person_id = a.id AND o.kind = 'alert' AND o.created_at > now() - interval '10 minutes'
        AND o.payload ->> 'workflow' = body ->> 'workflow' AND o.payload ->> 'message' = body ->> 'message');
  GET DIAGNOSTICS queued = ROW_COUNT;
  RETURN jsonb_build_object('queued', queued);
END $$;
