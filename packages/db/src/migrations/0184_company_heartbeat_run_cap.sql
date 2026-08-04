ALTER TABLE "companies" ADD COLUMN "max_concurrent_heartbeat_runs" integer;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_max_concurrent_heartbeat_runs_positive" CHECK ("max_concurrent_heartbeat_runs" IS NULL OR "max_concurrent_heartbeat_runs" > 0);
