-- ============================================================
--  GATEZY — Complete Database Schema
--  PostgreSQL 15+
--  "Your Gate. Your Control."
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
--  1. SOCIETIES
--  One row per residential society using GATEZY
-- ============================================================
CREATE TABLE societies (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(120) NOT NULL,
  city             VARCHAR(80)  NOT NULL,
  address          TEXT,
  total_flats      INT          NOT NULL DEFAULT 0,
  secretary_phone  VARCHAR(15)  NOT NULL,          -- gets daily WhatsApp report
  plan             VARCHAR(20)  NOT NULL DEFAULT 'basic', -- basic | pro
  is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
--  2. FLATS
--  Every flat inside a society
-- ============================================================
CREATE TABLE flats (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id   UUID        NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  flat_number  VARCHAR(20) NOT NULL,               -- e.g. "204", "B-12"
  block        VARCHAR(20),                        -- e.g. "A", "B", null if no blocks
  floor        VARCHAR(10),                        -- e.g. "2", "GF"
  is_occupied  BOOLEAN     NOT NULL DEFAULT TRUE,
  UNIQUE (society_id, flat_number, block)          -- no duplicate flats per society
);

-- Index: look up flats by society fast
CREATE INDEX idx_flats_society ON flats(society_id);

-- ============================================================
--  3. RESIDENTS
--  People who live in flats — get WhatsApp notifications
-- ============================================================
CREATE TABLE residents (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flat_id     UUID        NOT NULL REFERENCES flats(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  phone       VARCHAR(15)  NOT NULL,               -- primary WhatsApp number
  alt_phone   VARCHAR(15),                         -- escalation step 2
  role        VARCHAR(20)  NOT NULL DEFAULT 'owner', -- owner | tenant | family
  is_primary  BOOLEAN      NOT NULL DEFAULT FALSE, -- primary contact for the flat
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (flat_id, phone)                          -- one resident per phone per flat
);

-- Index: look up resident by phone number fast (webhook matching)
CREATE INDEX idx_residents_phone     ON residents(phone);
CREATE INDEX idx_residents_flat      ON residents(flat_id);
CREATE INDEX idx_residents_primary   ON residents(flat_id, is_primary) WHERE is_primary = TRUE;

-- ============================================================
--  4. GUARDS
--  Security guards — use the guard app
-- ============================================================
CREATE TABLE guards (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id  UUID        NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  phone       VARCHAR(15)  NOT NULL UNIQUE,        -- login identifier
  pin_hash    VARCHAR(255) NOT NULL,               -- bcrypt hashed 4-digit PIN
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index: login lookup by phone
CREATE INDEX idx_guards_phone     ON guards(phone);
CREATE INDEX idx_guards_society   ON guards(society_id);

-- ============================================================
--  5. SHIFTS
--  Each time a guard clocks in and out
-- ============================================================
CREATE TABLE shifts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id        UUID        NOT NULL REFERENCES guards(id),
  society_id      UUID        NOT NULL REFERENCES societies(id),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,                     -- null = shift still active
  total_visitors  INT         NOT NULL DEFAULT 0,  -- updated on shift close
  status          VARCHAR(20) NOT NULL DEFAULT 'active' -- active | closed
    CHECK (status IN ('active','closed'))
);

-- Index: active shift lookup per guard
CREATE INDEX idx_shifts_guard    ON shifts(guard_id);
CREATE INDEX idx_shifts_active   ON shifts(guard_id, status) WHERE status = 'active';
CREATE INDEX idx_shifts_society  ON shifts(society_id, started_at DESC);

-- ============================================================
--  6. VISITOR REQUESTS
--  Core table — every visitor entry attempt
-- ============================================================
CREATE TABLE visitor_requests (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relations
  society_id        UUID        NOT NULL REFERENCES societies(id),
  flat_id           UUID        NOT NULL REFERENCES flats(id),
  guard_id          UUID        NOT NULL REFERENCES guards(id),
  shift_id          UUID        NOT NULL REFERENCES shifts(id),

  -- Visitor details
  visitor_name      VARCHAR(100) NOT NULL,
  visitor_phone     VARCHAR(15),                   -- optional, for returning visitor match
  purpose           VARCHAR(80)  NOT NULL,          -- delivery | personal | service | etc

  -- Photo
  photo_url         TEXT,                          -- Cloudflare R2 URL
  photo_deleted     BOOLEAN      NOT NULL DEFAULT FALSE,
  photo_deleted_at  TIMESTAMPTZ,                   -- set by nightly CRON after 30 days

  -- Status machine: pending → allowed | denied | no_response
  status            VARCHAR(20)  NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','allowed','denied','no_response')),

  -- Exit tracking
  exit_status       VARCHAR(20)  NOT NULL DEFAULT 'inside'
    CHECK (exit_status IN ('inside','exited')),
  exited_at         TIMESTAMPTZ,                   -- when guard tapped exit

  -- Emergency override
  is_emergency      BOOLEAN      NOT NULL DEFAULT FALSE,
  emergency_type    VARCHAR(30),                   -- ambulance | police | fire

  -- Pre-approval bypass
  is_preapproved    BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Timestamps
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ                    -- when decision was made
);

-- *** CRITICAL INDEXES — these make 1000+ users feel instant ***

-- Most common query: get all pending requests for a society
CREATE INDEX idx_vr_society_status    ON visitor_requests(society_id, status)
  WHERE status = 'pending';

-- Guard app: get today's requests for a shift
CREATE INDEX idx_vr_shift             ON visitor_requests(shift_id, created_at DESC);

-- CRON job: find photos older than 30 days to delete
CREATE INDEX idx_vr_photo_cleanup     ON visitor_requests(created_at)
  WHERE photo_deleted = FALSE;

-- Returning visitor lookup by phone
CREATE INDEX idx_vr_visitor_phone     ON visitor_requests(society_id, visitor_phone)
  WHERE visitor_phone IS NOT NULL;

-- Exit tracking: who is currently inside
CREATE INDEX idx_vr_inside            ON visitor_requests(society_id, exit_status)
  WHERE exit_status = 'inside' AND status = 'allowed';

-- Admin dashboard: recent entries per society
CREATE INDEX idx_vr_society_time      ON visitor_requests(society_id, created_at DESC);

-- ============================================================
--  7. APPROVALS
--  Records the actual decision made — who approved, how, when
-- ============================================================
CREATE TABLE approvals (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       UUID        NOT NULL REFERENCES visitor_requests(id),
  resident_id      UUID        NOT NULL REFERENCES residents(id),
  decision         VARCHAR(10)  NOT NULL
    CHECK (decision IN ('allow','deny')),
  channel          VARCHAR(20)  NOT NULL
    CHECK (channel IN ('whatsapp','voice_call','manual')),
  escalation_step  INT          NOT NULL DEFAULT 1, -- which step triggered this (1-4)
  decided_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (request_id)                               -- only one final decision per request
);

CREATE INDEX idx_approvals_request ON approvals(request_id);
CREATE INDEX idx_approvals_resident ON approvals(resident_id, decided_at DESC);

-- ============================================================
--  8. ESCALATIONS
--  Tracks every escalation job fired per request
-- ============================================================
CREATE TABLE escalations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID        NOT NULL REFERENCES visitor_requests(id),
  step          INT          NOT NULL
    CHECK (step BETWEEN 1 AND 4),                  -- 1=30s, 2=60s, 3=90s alt, 4=call
  channel       VARCHAR(20)  NOT NULL
    CHECK (channel IN ('whatsapp','whatsapp_alt','voice_call')),
  status        VARCHAR(20)  NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','fired','cancelled','failed')),
  job_id        VARCHAR(100),                      -- Bull Queue job ID for cancellation
  fired_at      TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ
);

-- Index: cancel all pending escalations for a request instantly
CREATE INDEX idx_escalations_request ON escalations(request_id, status)
  WHERE status IN ('queued','fired');

-- ============================================================
--  9. PREAPPROVALS
--  Resident pre-registers regular visitors
-- ============================================================
CREATE TABLE preapprovals (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flat_id        UUID        NOT NULL REFERENCES flats(id) ON DELETE CASCADE,
  created_by     UUID        NOT NULL REFERENCES residents(id),
  visitor_name   VARCHAR(100) NOT NULL,
  visitor_phone  VARCHAR(15),                      -- primary match key
  purpose        VARCHAR(80),
  allowed_days   VARCHAR(20)  NOT NULL DEFAULT 'mon,tue,wed,thu,fri,sat,sun',
  time_from      TIME         NOT NULL DEFAULT '00:00',
  time_to        TIME         NOT NULL DEFAULT '23:59',
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index: fast preapproval check on every visitor arrival
CREATE INDEX idx_preapprovals_flat    ON preapprovals(flat_id, is_active)
  WHERE is_active = TRUE;
CREATE INDEX idx_preapprovals_phone   ON preapprovals(visitor_phone)
  WHERE visitor_phone IS NOT NULL AND is_active = TRUE;

-- ============================================================
--  VIEWS — pre-built queries your backend will use constantly
-- ============================================================

-- Who is currently inside the society right now
CREATE VIEW current_visitors AS
  SELECT
    vr.id,
    vr.society_id,
    vr.visitor_name,
    vr.visitor_phone,
    vr.purpose,
    vr.photo_url,
    vr.created_at   AS entered_at,
    f.flat_number,
    f.block,
    g.name          AS guard_name
  FROM visitor_requests vr
  JOIN flats  f ON f.id = vr.flat_id
  JOIN guards g ON g.id = vr.guard_id
  WHERE vr.status = 'allowed'
    AND vr.exit_status = 'inside';

-- Daily summary per society (used by admin report CRON)
CREATE VIEW daily_summary AS
  SELECT
    society_id,
    DATE(created_at)                                    AS visit_date,
    COUNT(*)                                            AS total_visitors,
    COUNT(*) FILTER (WHERE status = 'allowed')          AS allowed,
    COUNT(*) FILTER (WHERE status = 'denied')           AS denied,
    COUNT(*) FILTER (WHERE status = 'no_response')      AS no_response,
    COUNT(*) FILTER (WHERE is_emergency = TRUE)         AS emergencies,
    COUNT(*) FILTER (WHERE is_preapproved = TRUE)       AS preapproved_auto
  FROM visitor_requests
  GROUP BY society_id, DATE(created_at);

-- ============================================================
--  CONNECTION POOLING NOTE
--  Run PgBouncer in front of Postgres on the same VPS:
--    max_client_conn = 1000
--    default_pool_size = 20
--    pool_mode = transaction
--  This lets 1000+ concurrent users share 20 DB connections.
--  Without this, 1000 users = 1000 connections = crash.
-- ============================================================

-- ============================================================
--  CRON JOBS (run via pg_cron extension or backend scheduler)
-- ============================================================

-- Install pg_cron:
--   CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Job 1: Delete photos older than 30 days — runs every night at 2AM
-- SELECT cron.schedule('photo-cleanup','0 2 * * *', $$
--   UPDATE visitor_requests
--   SET    photo_url        = NULL,
--          photo_deleted    = TRUE,
--          photo_deleted_at = NOW()
--   WHERE  created_at < NOW() - INTERVAL '30 days'
--     AND  photo_deleted = FALSE;
-- $$);

-- Job 2: Daily admin report trigger — runs every morning at 8AM
-- (actual WhatsApp send handled by Node.js backend)
-- SELECT cron.schedule('daily-report','0 8 * * *', $$
--   NOTIFY daily_report_trigger, 'run';
-- $$);
