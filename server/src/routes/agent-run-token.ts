import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { agents, heartbeatRuns, type Db } from '@paperclipai/db';
import { isAgentStatusInvokable, normalizeAgentApiKeyScope } from '@paperclipai/shared';
import {
  createLocalAgentJwt,
  verifyLocalAgentJwt,
  verifyRefreshableLocalAgentJwt,
} from '../agent-auth-jwt.js';
import { HttpError, unauthorized, unprocessable } from '../errors.js';

function bearerToken(value: string | undefined) {
  if (typeof value !== 'string') return null;
  if (value.toLowerCase().startsWith('bearer ') === false) return null;
  return value.slice('bearer '.length).trim() || null;
}

export function agentRunTokenRoutes(db: Db) {
  const router = Router();

  // Mounted before actorMiddleware so an expired, signed run token can reach
  // this one narrow exchange after normal API authentication fails closed.
  router.post('/refresh', async (req, res) => {
    const token = bearerToken(req.header('authorization'));
    const claims = token ? verifyRefreshableLocalAgentJwt(token) : null;
    if (!claims) throw unauthorized('Valid agent run token required');

    const runIdHeader = req.header('x-paperclip-run-id')?.trim();
    if (!runIdHeader || runIdHeader !== claims.run_id) {
      throw unprocessable('X-Paperclip-Run-Id must match the signed agent JWT run_id', {
        code: 'agent_jwt_run_id_mismatch',
      });
    }

    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        responsibleUserId: heartbeatRuns.responsibleUserId,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, claims.run_id),
          eq(heartbeatRuns.companyId, claims.company_id),
          eq(heartbeatRuns.agentId, claims.sub),
        ),
      )
      .then((rows) => rows[0] ?? null);

    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, claims.sub), eq(agents.companyId, claims.company_id)))
      .then((rows) => rows[0] ?? null);

    if (!run || run.status !== 'running' || !agent || !isAgentStatusInvokable(agent.status)) {
      throw unauthorized('Agent run is not active');
    }

    const refreshedToken = createLocalAgentJwt(
      claims.sub,
      claims.company_id,
      claims.adapter_type,
      claims.run_id,
      claims.responsible_user_id === undefined
        ? run.responsibleUserId
        : claims.responsible_user_id,
      normalizeAgentApiKeyScope(claims.key_scope),
    );
    if (!refreshedToken) {
      throw new HttpError(503, 'Agent run token refresh is unavailable');
    }

    const refreshedClaims = verifyLocalAgentJwt(refreshedToken);
    if (!refreshedClaims) {
      throw new HttpError(503, 'Agent run token refresh failed');
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      token: refreshedToken,
      tokenType: 'Bearer',
      expiresAt: new Date(refreshedClaims.exp * 1000).toISOString(),
    });
  });

  return router;
}
