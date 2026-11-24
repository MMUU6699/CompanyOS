-- Migration: validate_daytona_connect_flows_status_check
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Expand step 2/2: validate the NOT VALID CHECK constraint added in
-- 20261124101225154_daytona_per_user_lifecycle.sql (SHARE UPDATE EXCLUSIVE —
-- does not block concurrent reads or writes).
ALTER TABLE "kortix"."daytona_connect_flows"
  VALIDATE CONSTRAINT "daytona_connect_flows_status_check";
