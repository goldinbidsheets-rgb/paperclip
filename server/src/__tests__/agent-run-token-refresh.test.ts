import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentApiKeys, agents, boardApiKeys, heartbeatRuns } from '@paperclipai/db';
import { createLocalAgentJwt, verifyLocalAgentJwt } from '../agent-auth-jwt.js';
import { errorHandler } from '../middleware/error-handler.js';
import { actorMiddleware } from '../middleware/auth.js';
import { agentRunTokenRoutes } from '../routes/agent-run-token.js';

interface Fixture {
  companyId: string;
  agentId: string;
  runId: string;
  runStatus?: string;
  agentStatus?: string;
}

function createDb(input: Fixture) {
  const run = {
    id: input.runId,
    companyId: input.companyId,
    agentId: input.agentId,
    status: input.runStatus ?? 'running',
    responsibleUserId: null,
  };
  const agent = {
    id: input.agentId,
    companyId: input.companyId,
    status: input.agentStatus ?? 'running',
  };

  return {
    select: () => ({
      from(table: unknown) {
        return {
          where() {
            if (table === heartbeatRuns) return Promise.resolve([run]);
            if (table === agents) return Promise.resolve([agent]);
            if (table === boardApiKeys || table === agentApiKeys) return Promise.resolve([]);
            return Promise.resolve([]);
          },
        };
      },
    }),
  } as any;
}

function createApp(fixture: Fixture) {
  const db = createDb(fixture);
  const app = express();
  const writes = new Map<string, Record<string, string | null>>();
  app.use(express.json());
  app.use('/api/auth/agent-run-token', agentRunTokenRoutes(db));
  app.use(actorMiddleware(db, { deploymentMode: 'authenticated', resolveSession: async () => null }));
  app.post('/write-probe', (req, res) => {
    if (req.actor.type !== 'agent') {
      res.status(401).json({ error: 'Agent authentication required' });
      return;
    }
    const persisted = {
      id: randomUUID(),
      authorType: req.actor.type,
      authorAgentId: req.actor.agentId,
      createdByRunId: req.actor.runId,
    };
    writes.set(persisted.id, persisted);
    res.status(201).json(persisted);
  });
  app.get('/write-probe/:id', (req, res) => {
    const persisted = writes.get(req.params.id);
    res.status(persisted ? 200 : 404).json(persisted ?? { error: 'Write not found' });
  });
  app.use(errorHandler);
  return app;
}

function mint(fixture: Fixture) {
  return createLocalAgentJwt(
    fixture.agentId,
    fixture.companyId,
    'codex_local',
    fixture.runId,
    null,
  )!;
}

function tamperToken(token: string) {
  const [head, body, signature] = token.split('.');
  const last = signature.slice(-1);
  return [head, body, signature.slice(0, -1) + (last === 'a' ? 'b' : 'a')].join('.');
}

describe('agent run token refresh', () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = 'run-token-refresh-secret';
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = '3600';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
  });

  it('refreshes an expired active-run JWT and preserves persisted attribution on read-back', async () => {
    const fixture = {
      companyId: randomUUID(),
      agentId: randomUUID(),
      runId: randomUUID(),
    };
    const app = createApp(fixture);
    const freshToken = mint(fixture);
    const invalidToken = tamperToken(freshToken);

    const validWithRun = await request(app)
      .post('/write-probe')
      .set('Authorization', 'Bearer ' + freshToken)
      .set('X-Paperclip-Run-Id', fixture.runId);
    const invalidWithRun = await request(app)
      .post('/write-probe')
      .set('Authorization', 'Bearer ' + invalidToken)
      .set('X-Paperclip-Run-Id', fixture.runId);
    const noAuthWithRun = await request(app)
      .post('/write-probe')
      .set('X-Paperclip-Run-Id', fixture.runId);
    const validWithoutRun = await request(app)
      .post('/write-probe')
      .set('Authorization', 'Bearer ' + freshToken);

    expect(validWithRun.status).toBe(201);
    expect(validWithRun.body).toMatchObject({
      authorType: 'agent',
      authorAgentId: fixture.agentId,
      createdByRunId: fixture.runId,
    });
    expect(invalidWithRun.status).toBe(401);
    expect(noAuthWithRun.status).toBe(401);
    expect(validWithoutRun.status).toBe(201);
    expect(validWithoutRun.body).toMatchObject({
      authorType: 'agent',
      authorAgentId: fixture.agentId,
      createdByRunId: fixture.runId,
    });

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now - 2 * 60 * 60 * 1000);
    const expiredToken = mint(fixture);
    vi.mocked(Date.now).mockReturnValue(now);
    expect(verifyLocalAgentJwt(expiredToken)).toBeNull();

    const refresh = await request(app)
      .post('/api/auth/agent-run-token/refresh')
      .set('Authorization', 'Bearer ' + expiredToken)
      .set('X-Paperclip-Run-Id', fixture.runId);
    expect(refresh.status, JSON.stringify(refresh.body)).toBe(200);
    expect(refresh.headers['cache-control']).toBe('no-store');
    expect(refresh.body.token).not.toBe(expiredToken);
    expect(verifyLocalAgentJwt(refresh.body.token)).toMatchObject({
      sub: fixture.agentId,
      company_id: fixture.companyId,
      run_id: fixture.runId,
    });

    const refreshedWrite = await request(app)
      .post('/write-probe')
      .set('Authorization', 'Bearer ' + refresh.body.token)
      .set('X-Paperclip-Run-Id', fixture.runId);
    expect(refreshedWrite.status).toBe(201);
    expect(refreshedWrite.body).toMatchObject({
      authorType: 'agent',
      authorAgentId: fixture.agentId,
      createdByRunId: fixture.runId,
    });

    const readBack = await request(app)
      .get('/write-probe/' + refreshedWrite.body.id)
      .set('Authorization', 'Bearer ' + refresh.body.token);
    expect(readBack.status).toBe(200);
    expect(readBack.body).toEqual(refreshedWrite.body);
  });

  it.each([
    { label: 'finished run', runStatus: 'succeeded', agentStatus: 'idle' },
    { label: 'paused agent', runStatus: 'running', agentStatus: 'paused' },
    { label: 'terminated agent', runStatus: 'running', agentStatus: 'terminated' },
  ])('rejects refresh for a $label', async ({ runStatus, agentStatus }) => {
    const fixture = {
      companyId: randomUUID(),
      agentId: randomUUID(),
      runId: randomUUID(),
      runStatus,
      agentStatus,
    };
    const app = createApp(fixture);
    const token = mint(fixture);

    const response = await request(app)
      .post('/api/auth/agent-run-token/refresh')
      .set('Authorization', 'Bearer ' + token)
      .set('X-Paperclip-Run-Id', fixture.runId);

    expect(response.status).toBe(401);
  });

  it('requires the signed run id header and a valid signature', async () => {
    const fixture = {
      companyId: randomUUID(),
      agentId: randomUUID(),
      runId: randomUUID(),
    };
    const app = createApp(fixture);
    const token = mint(fixture);
    const invalidToken = tamperToken(token);

    const missingRunId = await request(app)
      .post('/api/auth/agent-run-token/refresh')
      .set('Authorization', 'Bearer ' + token);
    const mismatchedRunId = await request(app)
      .post('/api/auth/agent-run-token/refresh')
      .set('Authorization', 'Bearer ' + token)
      .set('X-Paperclip-Run-Id', randomUUID());
    const invalidSignature = await request(app)
      .post('/api/auth/agent-run-token/refresh')
      .set('Authorization', 'Bearer ' + invalidToken)
      .set('X-Paperclip-Run-Id', fixture.runId);

    expect(missingRunId.status).toBe(422);
    expect(mismatchedRunId.status).toBe(422);
    expect(invalidSignature.status).toBe(401);
  });
});
