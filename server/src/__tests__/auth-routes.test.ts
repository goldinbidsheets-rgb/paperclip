import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { localImplicitBrowserIntentGuard } from "../middleware/board-mutation-guard.js";
import { authRoutes } from "../routes/auth.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createUpdateChain(row: unknown) {
  return {
    set(values: unknown) {
      return {
        where() {
          return {
            returning() {
              return Promise.resolve([{ ...(row as Record<string, unknown>), ...(values as Record<string, unknown>) }]);
            },
          };
        },
      };
    },
  };
}

function createDb(row: Record<string, unknown>) {
  return {
    select: () => createSelectChain([row]),
    update: () => createUpdateChain(row),
  } as any;
}

function createApp(actor: Express.Request["actor"], row: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api/auth",
    localImplicitBrowserIntentGuard({
      bindHost: "127.0.0.1",
      serverPort: 3100,
      publicUrl: null,
    }),
    authRoutes(createDb(row)),
  );
  app.use(errorHandler);
  return app;
}

describe.sequential("auth routes", () => {
  const baseUser = {
    id: "user-1",
    name: "Jane Example",
    email: "jane@example.com",
    image: "https://example.com/jane.png",
  };

  it("returns the persisted user profile in the session payload", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      session: {
        id: "paperclip:session:user-1",
        userId: "user-1",
      },
      user: baseUser,
    });
  });

  it("updates the local-implicit profile from a trusted origin", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .set("Origin", "http://127.0.0.1:3100")
      .send({ name: "Board Operator", image: "" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "user-1",
      name: "Board Operator",
      email: "jane@example.com",
      image: null,
    });
  });

  it("rejects a headerless local-implicit profile mutation", async () => {
    const app = await createApp(
      { type: "board", userId: "user-1", source: "local_implicit" },
      baseUser,
    );

    const res = await request(app).patch("/api/auth/profile").send({ name: "Blocked" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Local board mutation requires trusted browser origin" });
  });

  it("preserves the existing avatar when updating only the profile name", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .set("Origin", "http://127.0.0.1:3100")
      .send({ name: "Board Operator" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "user-1",
      name: "Board Operator",
      email: "jane@example.com",
      image: "https://example.com/jane.png",
    });
  });

  it("accepts Paperclip asset paths for avatars", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Jane Example", image: "/api/assets/asset-1/content" });

    expect(res.status).toBe(200);
    expect(res.body.image).toBe("/api/assets/asset-1/content");
  });

  it("rejects invalid avatar image references", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Jane Example", image: "not-a-url" });

    expect(res.status).toBe(400);
  });
});
