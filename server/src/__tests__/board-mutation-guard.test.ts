import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  boardMutationGuard,
  localImplicitMutationGuard,
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

function createProtectedApiApp(
  actorType: "board" | "agent",
  boardSource: "session" | "local_implicit" | "board_key" | "cloud_tenant" = "session",
  onMutation: () => void = () => undefined,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actorType === "board"
      ? { type: "board", userId: "board", source: boardSource }
      : { type: "agent", agentId: "agent-1" };
    next();
  });

  const api = express.Router();
  api.use(localImplicitMutationGuard());
  api.use(boardMutationGuard());
  const mutate = (_req: express.Request, res: express.Response) => {
    onMutation();
    res.status(204).end();
  };
  api.post("/issues/:id/comments", mutate);
  api.post("/issues/:id/checkout", mutate);
  api.put("/issues/:id/documents/:key", mutate);
  api.get("/probe", mutate);
  app.use("/api", api);

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

describe("localImplicitMutationGuard", () => {
  it("rejects a headerless comment before the mutation can supersede an interaction", async () => {
    const onMutation = vi.fn();
    const app = createProtectedApiApp("board", "local_implicit", onMutation);

    const res = await request(app).post("/api/issues/123/comments").send({ body: "hi" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required for this mutation" });
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("rejects an untrusted local-implicit origin", async () => {
    const app = createProtectedApiApp("board", "local_implicit");
    const res = await request(app)
      .post("/api/issues/123/checkout")
      .set("Origin", "https://evil.example.com")
      .send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required for this mutation" });
  });

  it("allows a trusted same-origin browser mutation", async () => {
    const onMutation = vi.fn();
    const app = createProtectedApiApp("board", "local_implicit", onMutation);
    const res = await request(app)
      .put("/api/issues/123/documents/plan")
      .set("Origin", "http://localhost:3100")
      .send({ body: "x" });

    expect(res.status).toBe(204);
    expect(onMutation).toHaveBeenCalledOnce();
  });

  it("allows safe local-implicit reads without browser headers", async () => {
    const app = createProtectedApiApp("board", "local_implicit");
    const res = await request(app).get("/api/probe");

    expect(res.status).toBe(204);
  });

  it("allows authenticated agents without browser headers", async () => {
    const app = createProtectedApiApp("agent");
    const res = await request(app).post("/api/issues/123/checkout").send({});

    expect(res.status).toBe(204);
  });

  it("allows board bearer keys without browser headers", async () => {
    const app = createProtectedApiApp("board", "board_key");
    const res = await request(app).post("/api/issues/123/checkout").send({});

    expect(res.status).toBe(204);
  });
});
