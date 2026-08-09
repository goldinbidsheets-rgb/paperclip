import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const issueAgentCollaboratorGrants = pgTable(
  "issue_agent_collaborator_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    granteeAgentId: uuid("grantee_agent_id").notNull().references(() => agents.id),
    capability: text("capability").notNull().default("comment:create"),
    grantedByActorType: text("granted_by_actor_type").notNull(),
    grantedByActorId: text("granted_by_actor_id").notNull(),
    grantedByRunId: uuid("granted_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedByActorType: text("revoked_by_actor_type"),
    revokedByActorId: text("revoked_by_actor_id"),
    revokedByRunId: uuid("revoked_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    capabilityCheck: check(
      "issue_agent_collaborator_grants_capability_check",
      sql`${table.capability} = 'comment:create'`,
    ),
    actorTypeCheck: check(
      "issue_agent_collaborator_grants_actor_type_check",
      sql`${table.grantedByActorType} in ('agent', 'user') and (${table.revokedByActorType} is null or ${table.revokedByActorType} in ('agent', 'user'))`,
    ),
    revocationShapeCheck: check(
      "issue_agent_collaborator_grants_revocation_shape_check",
      sql`(${table.revokedAt} is null and ${table.revokedByActorType} is null and ${table.revokedByActorId} is null and ${table.revokedByRunId} is null) or (${table.revokedAt} is not null and ${table.revokedByActorType} is not null and ${table.revokedByActorId} is not null)`,
    ),
    activeGrantUnique: uniqueIndex("issue_agent_collaborator_grants_active_uq")
      .on(table.companyId, table.issueId, table.granteeAgentId)
      .where(sql`${table.revokedAt} is null`),
    issueHistoryIdx: index("issue_agent_collaborator_grants_issue_history_idx")
      .on(table.companyId, table.issueId, table.grantedAt),
    agentActiveIdx: index("issue_agent_collaborator_grants_agent_active_idx")
      .on(table.companyId, table.granteeAgentId, table.revokedAt),
  }),
);
