-- Migration: user_daytona_credentials
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS "kortix"."user_daytona_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"encryption_iv" text NOT NULL,
	"encryption_tag" text NOT NULL,
	"daytona_org_id" text NOT NULL,
	"daytona_region" text DEFAULT 'eu' NOT NULL,
	"snapshot_name" text,
	"snapshot_status" text DEFAULT 'pending' NOT NULL,
	"snapshot_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_daytona_credentials_snapshot_status_check" CHECK ("snapshot_status" IN ('pending', 'pulling', 'active', 'inactive', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."user_daytona_credentials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_daytona_credentials_org_id" ON "kortix"."user_daytona_credentials" USING btree ("daytona_org_id");
--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."user_daytona_credentials" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "kortix"."user_daytona_credentials" TO service_role;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kortix"."daytona_connect_flows" (
	"flow_id" uuid PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"verification_uri_complete" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"encrypted_api_key" text,
	"encryption_iv" text,
	"encryption_tag" text,
	"daytona_org_id" text,
	"daytona_region" text,
	"claim_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daytona_connect_flows_status_check" CHECK ("status" IN ('pending', 'approved', 'claimed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."daytona_connect_flows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_daytona_connect_flows_claim_token" ON "kortix"."daytona_connect_flows" USING btree ("claim_token") WHERE "claim_token" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_daytona_connect_flows_expires_at" ON "kortix"."daytona_connect_flows" USING btree ("expires_at");
--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."daytona_connect_flows" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "kortix"."daytona_connect_flows" TO service_role;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kortix_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "kortix"."user_daytona_credentials" TO kortix_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "kortix"."daytona_connect_flows" TO kortix_app;
  END IF;
END
$$;
