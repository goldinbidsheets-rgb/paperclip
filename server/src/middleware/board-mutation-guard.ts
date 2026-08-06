import type { Request, RequestHandler } from "express";

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

function hasConfiguredBrowserOrigin(req: Request, allowedOrigins: ReadonlySet<string>) {
  const origin = parseOrigin(req.header("origin"));
  if (origin && allowedOrigins.has(origin)) return true;

  const refererOrigin = parseOrigin(req.header("referer"));
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return true;

  return false;
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
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}

export function localImplicitBrowserIntentGuard(opts: BoardMutationOriginOptions): RequestHandler {
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

    if (!hasConfiguredBrowserOrigin(req, allowedOrigins)) {
      res.status(403).json({ error: "Local board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
