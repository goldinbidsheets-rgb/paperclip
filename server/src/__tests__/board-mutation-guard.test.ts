import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  boardMutationGuard,
  localImplicitBrowserIntentGuard,
} from "../middleware/board-mutation-guard.js";
import { logger } from "../middleware/logger.js";

const ORIGIN_OPTIONS = {
  bindHost: "127.0.0.1",
  serverPort: 3200,
  publicUrl: "https://paperclip.example.test",
};

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
  app.use(boardMutationGuard(ORIGIN_OPTIONS));
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
  api.use(localImplicitBrowserIntentGuard(ORIGIN_OPTIONS));
  api.use(boardMutationGuard(ORIGIN_OPTIONS));
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
    const middleware = boardMutationGuard(ORIGIN_OPTIONS);
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

  it("allows board mutations from the configured bind origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Origin", "http://127.0.0.1:3200")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations from the configured public URL", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Referer", "https://paperclip.example.test/issues/abc")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("does not trust a caller-controlled Host", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Host", "evil.example")
      .set("Origin", "http://evil.example")
      .send({ ok: true });
    expect(res.status).toBe(403);
  });

  it("does not trust X-Forwarded-Host from the caller", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("X-Forwarded-Host", "attacker.test")
      .set("Origin", "http://attacker.test")
      .send({ ok: true });
    expect(res.status).toBe(403);
  });

  it("does not retain the old hard-coded development origins", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Origin", "http://localhost:3100")
      .send({ ok: true });
    expect(res.status).toBe(403);
  });

  it("does not block authenticated agent mutations", async () => {
    const middleware = boardMutationGuard(ORIGIN_OPTIONS);
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

describe("localImplicitBrowserIntentGuard", () => {
  it("rejects a headerless comment before the mutation can supersede an interaction", async () => {
    const onMutation = vi.fn();
    const app = createProtectedApiApp("board", "local_implicit", onMutation);

    const res = await request(app).post("/api/issues/123/comments").send({ body: "hi" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Local board mutation requires trusted browser origin" });
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("rejects an untrusted local-implicit origin", async () => {
    const app = createProtectedApiApp("board", "local_implicit");
    const res = await request(app)
      .post("/api/issues/123/checkout")
      .set("Origin", "https://evil.example.com")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Local board mutation requires trusted browser origin" });
  });

  it("rejects the old hard-coded 127.0.0.1:3100 origin", async () => {
    const app = createProtectedApiApp("board", "local_implicit");
    const res = await request(app)
      .post("/api/issues/123/checkout")
      .set("Origin", "http://127.0.0.1:3100")
      .send({});

    expect(res.status).toBe(403);
  });

  it("rejects the old hard-coded localhost:3100 referer", async () => {
    const app = createProtectedApiApp("board", "local_implicit");
    const res = await request(app)
      .post("/api/issues/123/checkout")
      .set("Referer", "http://localhost:3100/some/page")
      .send({});

    expect(res.status).toBe(403);
  });

  it("allows a browser mutation from the configured bind origin", async () => {
    const onMutation = vi.fn();
    const app = createProtectedApiApp("board", "local_implicit", onMutation);
    const res = await request(app)
      .put("/api/issues/123/documents/plan")
      .set("Origin", "http://127.0.0.1:3200")
      .send({ body: "x" });

    expect(res.status).toBe(204);
    expect(onMutation).toHaveBeenCalledOnce();
  });

  it("rejects matching caller-controlled Host and Origin headers", async () => {
    const app = createProtectedApiApp("board", "local_implicit");
    const res = await request(app)
      .post("/api/issues/123/checkout")
      .set("Host", "evil.example")
      .set("Origin", "http://evil.example")
      .send({});

    expect(res.status).toBe(403);
  });

  it("rejects matching caller-controlled X-Forwarded-Host and Origin headers", async () => {
    const app = createProtectedApiApp("board", "local_implicit");
    const res = await request(app)
      .post("/api/issues/123/checkout")
      .set("X-Forwarded-Host", "attacker.test")
      .set("Origin", "http://attacker.test")
      .send({});

    expect(res.status).toBe(403);
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

describe("guard rejection logging (R6 / GOLAA-13127)", () => {
  function findEvent(spy: ReturnType<typeof vi.spyOn>) {
    const call = spy.mock.calls.find(
      (c) => (c[0] as Record<string, unknown> | undefined)?.event === "security.auth_guard_rejected",
    );
    return call?.[0] as Record<string, unknown> | undefined;
  }

  it("emits a structured security event when boardMutationGuard rejects", async () => {
    const spy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    try {
      const app = createApp("board", "session");
      const res = await request(app).post("/mutate").send({});
      expect(res.status).toBe(403);

      const fields = findEvent(spy);
      expect(fields).toBeTruthy();
      expect(fields!.guard).toBe("boardMutationGuard");
      expect(fields!.method).toBe("POST");
      expect(fields!.actorType).toBe("board");
      expect(fields!.actorSource).toBe("session");
      expect(fields!.originPresent).toBe(false);
      expect(fields!.refererPresent).toBe(false);
      // Never log the raw Origin/Referer values — presence booleans only.
      expect(fields).not.toHaveProperty("origin");
      expect(fields).not.toHaveProperty("referer");
    } finally {
      spy.mockRestore();
    }
  });

  it("names localImplicitBrowserIntentGuard and reports origin presence on rejection", async () => {
    const spy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    try {
      const app = createProtectedApiApp("board", "local_implicit");
      const res = await request(app)
        .post("/api/issues/123/checkout")
        .set("Origin", "http://attacker.test")
        .send({});
      expect(res.status).toBe(403);

      const fields = findEvent(spy);
      expect(fields).toBeTruthy();
      expect(fields!.guard).toBe("localImplicitBrowserIntentGuard");
      expect(fields!.actorSource).toBe("local_implicit");
      expect(fields!.originPresent).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not log a rejection event when a trusted origin is accepted", async () => {
    const spy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    try {
      const app = createProtectedApiApp("board", "local_implicit");
      const res = await request(app)
        .post("/api/issues/123/checkout")
        .set("Origin", "https://paperclip.example.test")
        .send({});
      expect(res.status).toBe(204);
      expect(findEvent(spy)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
