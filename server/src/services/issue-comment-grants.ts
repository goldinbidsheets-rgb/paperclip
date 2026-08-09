import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueAgentCollaboratorGrants } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

export const ISSUE_COMMENT_COLLABORATOR_CAPABILITY = "comment:create" as const;

export type IssueCommentGrantActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
};

export async function hasActiveIssueCommentGrant(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string },
) {
  return db
    .select({ id: issueAgentCollaboratorGrants.id })
    .from(issueAgentCollaboratorGrants)
    .where(and(
      eq(issueAgentCollaboratorGrants.companyId, input.companyId),
      eq(issueAgentCollaboratorGrants.issueId, input.issueId),
      eq(issueAgentCollaboratorGrants.granteeAgentId, input.agentId),
      eq(issueAgentCollaboratorGrants.capability, ISSUE_COMMENT_COLLABORATOR_CAPABILITY),
      isNull(issueAgentCollaboratorGrants.revokedAt),
    ))
    .limit(1)
    .then((rows) => rows.length === 1);
}

export function issueCommentGrantService(db: Db) {
  async function listForIssue(companyId: string, issueId: string, includeRevoked = false) {
    return db
      .select({
        grant: issueAgentCollaboratorGrants,
        agentName: agents.name,
        agentRole: agents.role,
        agentStatus: agents.status,
      })
      .from(issueAgentCollaboratorGrants)
      .innerJoin(agents, eq(agents.id, issueAgentCollaboratorGrants.granteeAgentId))
      .where(and(
        eq(issueAgentCollaboratorGrants.companyId, companyId),
        eq(issueAgentCollaboratorGrants.issueId, issueId),
        ...(includeRevoked ? [] : [isNull(issueAgentCollaboratorGrants.revokedAt)]),
      ))
      .orderBy(desc(issueAgentCollaboratorGrants.grantedAt));
  }

  async function grant(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    actor: IssueCommentGrantActor;
  }) {
    return db.transaction(async (tx) => {
      const target = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!target) return { kind: "agent_not_found" as const };

      const values = {
        companyId: input.companyId,
        issueId: input.issueId,
        granteeAgentId: input.agentId,
        capability: ISSUE_COMMENT_COLLABORATOR_CAPABILITY,
        grantedByActorType: input.actor.actorType,
        grantedByActorId: input.actor.actorId,
        grantedByRunId: input.actor.runId ?? null,
      };
      let inserted: typeof issueAgentCollaboratorGrants.$inferSelect | null = null;
      let activeGrant: typeof issueAgentCollaboratorGrants.$inferSelect | null = null;
      for (let attempt = 0; attempt < 2 && !activeGrant; attempt += 1) {
        inserted = await tx.insert(issueAgentCollaboratorGrants)
          .values(values)
          .onConflictDoNothing()
          .returning()
          .then((rows) => rows[0] ?? null);
        activeGrant = inserted ?? await tx.select()
          .from(issueAgentCollaboratorGrants)
          .where(and(
            eq(issueAgentCollaboratorGrants.companyId, input.companyId),
            eq(issueAgentCollaboratorGrants.issueId, input.issueId),
            eq(issueAgentCollaboratorGrants.granteeAgentId, input.agentId),
            isNull(issueAgentCollaboratorGrants.revokedAt),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
      }
      if (!activeGrant) throw new Error("Failed to resolve active issue comment collaborator grant");

      if (inserted) {
        await logActivity(tx as unknown as Db, {
          companyId: input.companyId,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: input.actor.agentId ?? null,
          runId: input.actor.runId ?? null,
          agentApiKeyId: input.actor.agentApiKeyId ?? null,
          issueId: input.issueId,
          action: "issue.comment_collaborator_granted",
          entityType: "issue_agent_collaborator_grant",
          entityId: activeGrant.id,
          details: {
            issueId: input.issueId,
            granteeAgentId: input.agentId,
            capability: ISSUE_COMMENT_COLLABORATOR_CAPABILITY,
          },
        });
      }
      return { kind: "ok" as const, grant: activeGrant, created: inserted !== null };
    });
  }

  async function revoke(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    actor: IssueCommentGrantActor;
  }) {
    return db.transaction(async (tx) => {
      const revoked = await tx
        .update(issueAgentCollaboratorGrants)
        .set({
          revokedAt: new Date(),
          revokedByActorType: input.actor.actorType,
          revokedByActorId: input.actor.actorId,
          revokedByRunId: input.actor.runId ?? null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(issueAgentCollaboratorGrants.companyId, input.companyId),
          eq(issueAgentCollaboratorGrants.issueId, input.issueId),
          eq(issueAgentCollaboratorGrants.granteeAgentId, input.agentId),
          isNull(issueAgentCollaboratorGrants.revokedAt),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!revoked) return { revoked: false as const, grant: null };

      await logActivity(tx as unknown as Db, {
        companyId: input.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId ?? null,
        runId: input.actor.runId ?? null,
        agentApiKeyId: input.actor.agentApiKeyId ?? null,
        issueId: input.issueId,
        action: "issue.comment_collaborator_revoked",
        entityType: "issue_agent_collaborator_grant",
        entityId: revoked.id,
        details: {
          issueId: input.issueId,
          granteeAgentId: input.agentId,
          capability: ISSUE_COMMENT_COLLABORATOR_CAPABILITY,
        },
      });
      return { revoked: true as const, grant: revoked };
    });
  }

  return { listForIssue, grant, revoke };
}
