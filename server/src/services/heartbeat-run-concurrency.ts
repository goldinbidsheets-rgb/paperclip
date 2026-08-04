import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, heartbeatRuns } from "@paperclipai/db";

export interface ClaimQueuedHeartbeatRunInput {
  runId: string;
  companyId: string;
  agentId: string;
  maxConcurrentRunsForAgent: number;
  responsibleUserId: string | null;
  startedAt: Date | null;
  claimedAt?: Date;
}

export type ClaimQueuedHeartbeatRunResult =
  | { kind: "claimed"; run: typeof heartbeatRuns.$inferSelect }
  | { kind: "capacity_exhausted" }
  | { kind: "not_queued" };

/**
 * The company row is the serialization point for all queued-to-running
 * promotions in that company. Keeping the count and conditional update in the
 * same transaction makes both company and per-agent limits safe across server
 * processes, not just within one scheduler's in-memory lock.
 */
export async function claimQueuedHeartbeatRunWithinLimits(
  db: Db,
  input: ClaimQueuedHeartbeatRunInput,
): Promise<ClaimQueuedHeartbeatRunResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${companies.id} from ${companies} where ${companies.id} = ${input.companyId} for update`,
    );

    const company = await tx
      .select({ maxConcurrentHeartbeatRuns: companies.maxConcurrentHeartbeatRuns })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) return { kind: "not_queued" as const };

    const [counts] = await tx
      .select({
        companyRunning: sql<number>`count(*)::integer`,
        agentRunning: sql<number>`count(*) filter (where ${heartbeatRuns.agentId} = ${input.agentId})::integer`,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.status, "running"),
      ));

    const companyRunning = Number(counts?.companyRunning ?? 0);
    const agentRunning = Number(counts?.agentRunning ?? 0);
    if (
      agentRunning >= input.maxConcurrentRunsForAgent
      || (
        company.maxConcurrentHeartbeatRuns !== null
        && companyRunning >= company.maxConcurrentHeartbeatRuns
      )
    ) {
      return { kind: "capacity_exhausted" as const };
    }

    const claimedAt = input.claimedAt ?? new Date();
    const claimed = await tx
      .update(heartbeatRuns)
      .set({
        status: "running",
        responsibleUserId: input.responsibleUserId,
        startedAt: input.startedAt ?? claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, "queued"),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);

    return claimed
      ? { kind: "claimed" as const, run: claimed }
      : { kind: "not_queued" as const };
  });
}
