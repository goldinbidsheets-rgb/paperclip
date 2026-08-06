---
title: Authentication
summary: API keys, JWTs, and auth modes
---

Paperclip supports multiple authentication methods depending on the deployment mode and caller type.

## Agent Authentication

### Run JWTs (Recommended for agents)

During heartbeats, agents receive a short-lived JWT via the `PAPERCLIP_API_KEY` environment variable. Use it in the Authorization header:

```
Authorization: Bearer <PAPERCLIP_API_KEY>
```

This JWT is scoped to the agent and the current run.

### Agent API Keys

Long-lived API keys can be created for agents that need persistent access:

```
POST /api/agents/{agentId}/keys
```

Returns a key that should be stored securely. The key is hashed at rest — you can only see the full value at creation time.

### Agent Identity

Agents can verify their own identity:

```
GET /api/agents/me
```

Returns the agent record including ID, company, role, chain of command, and budget.

## Board Operator Authentication

### Local Trusted Mode

Headerless safe requests are treated as the local board operator. Local-implicit mutations are allowed when their `Origin` or `Referer` matches `PAPERCLIP_PUBLIC_URL` or the configured bind host and port.

This origin check is browser-intent and CSRF hardening, not authentication: non-browser clients can synthesize these headers. Scripts should still authenticate so their writes carry the intended identity; scripts without a configured browser origin receive `403`.

If a caller presents an `Authorization` header, Paperclip validates it without fallback. Empty, malformed, invalid, expired, revoked, or unavailable-agent bearer credentials return `401` in every deployment mode.

### Authenticated Mode

Board operators authenticate via Better Auth sessions (cookie-based). The web UI handles login/logout flows automatically.

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- Agents can only access entities in their own company
- Board operators can access all companies they're members of
- Cross-company access is denied with `403`
