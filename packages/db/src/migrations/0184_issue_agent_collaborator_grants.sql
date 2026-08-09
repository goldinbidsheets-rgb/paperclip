CREATE TABLE "issue_agent_collaborator_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"grantee_agent_id" uuid NOT NULL,
	"capability" text DEFAULT 'comment:create' NOT NULL,
	"granted_by_actor_type" text NOT NULL,
	"granted_by_actor_id" text NOT NULL,
	"granted_by_run_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_actor_type" text,
	"revoked_by_actor_id" text,
	"revoked_by_run_id" uuid,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_agent_collaborator_grants_capability_check" CHECK ("capability" = 'comment:create'),
	CONSTRAINT "issue_agent_collaborator_grants_actor_type_check" CHECK ("granted_by_actor_type" in ('agent', 'user') and ("revoked_by_actor_type" is null or "revoked_by_actor_type" in ('agent', 'user'))),
	CONSTRAINT "issue_agent_collaborator_grants_revocation_shape_check" CHECK (("revoked_at" is null and "revoked_by_actor_type" is null and "revoked_by_actor_id" is null and "revoked_by_run_id" is null) or ("revoked_at" is not null and "revoked_by_actor_type" is not null and "revoked_by_actor_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "issue_agent_collaborator_grants" ADD CONSTRAINT "issue_agent_collaborator_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_agent_collaborator_grants" ADD CONSTRAINT "issue_agent_collaborator_grants_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_agent_collaborator_grants" ADD CONSTRAINT "issue_agent_collaborator_grants_grantee_agent_id_agents_id_fk" FOREIGN KEY ("grantee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_agent_collaborator_grants" ADD CONSTRAINT "issue_agent_collaborator_grants_granted_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("granted_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_agent_collaborator_grants" ADD CONSTRAINT "issue_agent_collaborator_grants_revoked_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("revoked_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_agent_collaborator_grants_active_uq" ON "issue_agent_collaborator_grants" USING btree ("company_id","issue_id","grantee_agent_id") WHERE "revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "issue_agent_collaborator_grants_issue_history_idx" ON "issue_agent_collaborator_grants" USING btree ("company_id","issue_id","granted_at");
--> statement-breakpoint
CREATE INDEX "issue_agent_collaborator_grants_agent_active_idx" ON "issue_agent_collaborator_grants" USING btree ("company_id","grantee_agent_id","revoked_at");
