import type { Request, RequestHandler } from "express";
import { logger } from "./logger.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface BoardMutationOriginOptions {
  bindHost: string;
  serverPort: number;
  publicUrl?: string | null;
}

function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function bindOrigin(bindHost: string, serverPort: number) {
  const host = bindHost.trim().toLowerCase();
  if (!host) return null;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return parseOrigin(`http://${urlHost}:${serverPort}`);
}

function trustedOriginsForConfig(opts: BoardMutationOriginOptions) {
  const origins = new Set<string>();
  const configuredBindOrigin = bindOrigin(opts.bindHost, opts.serverPort);
  if (configuredBindOrigin) origins.add(configuredBindOrigin);
  const publicUrl = parseOrigin(opts.publicUrl?.trim());
  if (publicUrl) origins.add(publicUrl);
  return origins;
}

// SECURITY BOUNDARY NOTE: this origin/referer match is browser-intent and
// CSRF hardening, NOT an authentication boundary. `Origin` and `Referer` are
// client-supplied and forgeable — any non-browser client can set a trusted
// origin and pass this check, so a passing result is never proof of identity.
// Presented-credential mediation (Authorization / session validation) is
// enforced separately in auth.ts and is the actual authentication boundary.
// Do not add authorization decisions here that assume this cannot be spoofed.
function hasConfiguredBrowserOrigin(req: Request, allowedOrigins: ReadonlySet<string>) {
  const origin = parseOrigin(req.header("origin"));
  if (origin && allowedOrigins.has(origin)) return true;

  const refererOrigin = parseOrigin(req.header("referer"));
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return true;

  return false;
}

// R6 (GOLAA-13127): guard rejections are security events. Emit a structured
// line so forging attempts (a script setting a spoofed Origin, see the boundary
// note above) are detectable and the accidental-write rate is measurable after
// deploy. Presence booleans only — never the Origin/Referer values — so no host
// or PII leaks into logs.
function logGuardRejection(req: Request, guard: string) {
  logger.warn(
    {
      event: "security.auth_guard_rejected",
      guard,
      method: req.method,
      path: req.path,
      actorType: req.actor.type,
      actorSource: req.actor.source,
      originPresent: Boolean(req.header("origin")),
      refererPresent: Boolean(req.header("referer")),
    },
    "board mutation guard rejected untrusted-origin request",
  );
}

export function boardMutationGuard(opts: BoardMutationOriginOptions): RequestHandler {
  const allowedOrigins = trustedOriginsForConfig(opts);
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (req.actor.type !== "board") {
      next();
      return;
    }

    // Local-trusted mode, board bearer keys, and trusted Cloud tenant calls are
    // not browser-session requests.
    // In these modes, origin/referer headers can be absent; do not block those mutations.
    if (
      req.actor.source === "local_implicit"
      || req.actor.source === "board_key"
      || req.actor.source === "cloud_tenant"
    ) {
      next();
      return;
    }

    if (!hasConfiguredBrowserOrigin(req, allowedOrigins)) {
      logGuardRejection(req, "boardMutationGuard");
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}

export function localImplicitBrowserIntentGuard(
  opts: BoardMutationOriginOptions,
  exemptPaths?: ReadonlySet<string>,
): RequestHandler {
  const allowedOrigins = trustedOriginsForConfig(opts);
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (req.actor.type !== "board" || req.actor.source !== "local_implicit") {
      next();
      return;
    }

    if (exemptPaths?.has(req.path)) {
      next();
      return;
    }

    if (!hasConfiguredBrowserOrigin(req, allowedOrigins)) {
      logGuardRejection(req, "localImplicitBrowserIntentGuard");
      res.status(403).json({ error: "Local board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
