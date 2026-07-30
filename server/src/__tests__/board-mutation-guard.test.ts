import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  boardMutationGuard,
  localImplicitIssueMutationGuard,
} from "../middleware/board-mutation-guard.js";

function createApp(
  actorType: "board" | "agent",
  boardSource: "session" | "local_implicit" | "board_key" | "cloud_tenant" = "session",
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actorType === "board"
      ? { type: "board", userId: "board", source: boardSource }
      : { type: "agent", agentId: "agent-1" };
    next();
  });
  app.use(boardMutationGuard());
  app.post("/mutate", (_req, res) => {
    res.status(204).end();
  });
  app.get("/read", (_req, res) => {
    res.status(204).end();
  });
  return app;
}

function createProtectedIssueApp(
  actorType: "board" | "agent",
  boardSource: "session" | "local_implicit" | "board_key" | "cloud_tenant" = "session",
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor =
      actorType === "board"
        ? { type: "board", userId: "board", source: boardSource }
        : { type: "agent", agentId: "agent-1" };
    next();
  });
  app.patch(
    "/api/issues/:id",
    localImplicitIssueMutationGuard(),
    boardMutationGuard(),
    (_req, res) => {
      res.status(204).end();
    },
  );
  app.post(
    "/api/issues/:id/comments",
    localImplicitIssueMutationGuard(),
    boardMutationGuard(),
    (_req, res) => {
      res.status(204).end();
    },
  );
  return app;
}

describe("boardMutationGuard", () => {
  it("allows safe methods for board actor", async () => {
    const app = createApp("board");
    const res = await request(app).get("/read");
    expect([200, 204]).toContain(res.status);
  });

  it("blocks board mutations without trusted origin", () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: { type: "board", userId: "board", source: "session" },
      header: () => undefined,
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Board mutation requires trusted browser origin",
    });
  });

  it("allows local implicit board mutations without origin", async () => {
    const app = createApp("board", "local_implicit");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board bearer-key mutations without origin", async () => {
    const app = createApp("board", "board_key");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows trusted Cloud tenant mutations without origin", async () => {
    const app = createApp("board", "cloud_tenant");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations from trusted origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Origin", "http://localhost:3100")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations from trusted referer origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Referer", "http://localhost:3100/issues/abc")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations when x-forwarded-host matches origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Host", "127.0.0.1")
      .set("X-Forwarded-Host", "10.90.10.20:3443")
      .set("Origin", "https://10.90.10.20:3443")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("blocks board mutations when x-forwarded-host does not match origin", async () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: { type: "board", userId: "board", source: "session" },
      header: (name: string) => {
        if (name === "host") return "127.0.0.1";
        if (name === "x-forwarded-host") return "10.90.10.20:3443";
        if (name === "origin") return "https://evil.example.com";
        return undefined;
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Board mutation requires trusted browser origin",
    });
  });

  it("does not block authenticated agent mutations", async () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: { type: "agent", agentId: "agent-1" },
      header: () => undefined,
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("localImplicitIssueMutationGuard", () => {
  it("returns 401 for a headerless local-implicit issue patch", async () => {
    const app = createProtectedIssueApp("board", "local_implicit");
    const res = await request(app).patch("/api/issues/123").send({ title: "x" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required for this issue mutation" });
  });

  it("returns 401 for a headerless local-implicit issue comment", async () => {
    const app = createProtectedIssueApp("board", "local_implicit");
    const res = await request(app).post("/api/issues/123/comments").send({ body: "hi" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required for this issue mutation" });
  });

  it("does not call the downstream handler when it rejects a request", () => {
    const middleware = localImplicitIssueMutationGuard();
    const req = {
      method: "PATCH",
      actor: { type: "board", userId: "board", source: "local_implicit" },
      header: () => undefined,
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Authentication required for this issue mutation",
    });
  });

  it("allows trusted same-origin browser requests to both protected routes", async () => {
    const app = createProtectedIssueApp("board", "local_implicit");
    const patchRes = await request(app)
      .patch("/api/issues/123")
      .set("Origin", "http://localhost:3100")
      .send({ title: "x" });
    const commentRes = await request(app)
      .post("/api/issues/123/comments")
      .set("Origin", "http://localhost:3100")
      .send({ body: "hi" });

    expect(patchRes.status).toBe(204);
    expect(commentRes.status).toBe(204);
  });

  it("allows a trusted same-origin referer", async () => {
    const app = createProtectedIssueApp("board", "local_implicit");
    const res = await request(app)
      .patch("/api/issues/123")
      .set("Referer", "http://localhost:3100/issues/123")
      .send({ title: "x" });

    expect(res.status).toBe(204);
  });

  it("allows authenticated agents without browser headers", async () => {
    const app = createProtectedIssueApp("agent");
    const res = await request(app).patch("/api/issues/123").send({ title: "x" });

    expect(res.status).toBe(204);
  });

  it("allows board-key requests without browser headers", async () => {
    const app = createProtectedIssueApp("board", "board_key");
    const res = await request(app).patch("/api/issues/123").send({ title: "x" });

    expect(res.status).toBe(204);
  });
});
