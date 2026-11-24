-- Migration: daytona_per_user_lifecycle
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Expand/contract checklist:
--   [x] All new columns on kortix.user_daytona_credentials and
--       kortix.daytona_connect_flows are additive and nullable.
--   [x] Widening CHECK constraint daytona_connect_flows_status_check from
--       ('pending','approved','claimed','expired') to
--       ('pending','exchanging','approved','claimed','expired') using NOT VALID;
--       VALIDATE CONSTRAINT runs in the companion migration immediately after.
-- mixed-version-safe: All added columns are nullable so older API pods ignore them.
-- Widening daytona_connect_flows_status_check adds 'exchanging' without rejecting any
-- existing status value; older pods only ever INSERT 'pending' and handle non-approved
-- statuses as pending/in-progress until the new rollout completes.

ALTER TABLE "kortix"."user_daytona_credentials"
  ADD COLUMN IF NOT EXISTS "daytona_key_name" text,
  ADD COLUMN IF NOT EXISTS "daytona_key_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "previous_daytona_org_id" text,
  ADD COLUMN IF NOT EXISTS "previous_org_replaced_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "snapshot_attempts" integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "snapshot_next_retry_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "max_running_sandboxes" integer,
  ADD COLUMN IF NOT EXISTS "max_non_archived_sandboxes" integer;

ALTER TABLE "kortix"."daytona_connect_flows"
  ADD COLUMN IF NOT EXISTS "daytona_key_name" text,
  ADD COLUMN IF NOT EXISTS "client_ip_hash" text,
  ADD COLUMN IF NOT EXISTS "terminal_error_code" text,
  ADD COLUMN IF NOT EXISTS "terminal_error_message" text,
  ADD COLUMN IF NOT EXISTS "terminal_error_status" integer;

ALTER TABLE "kortix"."daytona_connect_flows"
  DROP CONSTRAINT IF EXISTS "daytona_connect_flows_status_check";

ALTER TABLE "kortix"."daytona_connect_flows"
  ADD CONSTRAINT "daytona_connect_flows_status_check"
  CHECK ("status" IN ('pending', 'exchanging', 'approved', 'claimed', 'expired')) NOT VALID;
