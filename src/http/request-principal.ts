import type { IncomingMessage, ServerResponse } from "node:http";
import { getAgentById } from "../be/db";
import type { RbacPrincipal } from "../rbac";
import type { User } from "../types";
import { getRequestAuth, type HttpRequestAuth } from "../utils/request-auth-context";
import { jsonError } from "./utils";

function assertNever(value: never): never {
  throw new Error(`Unhandled HttpRequestAuth: ${JSON.stringify(value)}`);
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export type PrincipalPrecedence = "operator-first" | "agent-first";

export type RequestPrincipalOptions = {
  precedence?: PrincipalPrecedence;
  requireRegisteredAgent?: boolean;
};

async function resolveAgentPrincipal(
  agentId: string | undefined,
  requireRegisteredAgent = false,
): Promise<RbacPrincipal | null> {
  if (!agentId) return null;
  const agent = await getAgentById(agentId);
  if (requireRegisteredAgent && !agent) return null;
  return { kind: "agent", agentId, isLead: agent?.isLead === true };
}

/**
 * The RBAC principal of an HTTP request, for a handler-side `can()` check.
 * By default (`operator-first`), operator and user request auth win over the
 * X-Agent-ID header (an operator bearer with any agent id stays the operator).
 * With `precedence: "agent-first"`, an X-Agent-ID header wins over the operator
 * bearer. An agent id that is not registered is a non-lead agent unless
 * `requireRegisteredAgent` is set. Null when the request has neither.
 */
export async function requestPrincipal(
  req: IncomingMessage,
  myAgentId?: string,
  opts?: RequestPrincipalOptions,
): Promise<RbacPrincipal | null> {
  const precedence = opts?.precedence ?? "operator-first";
  const requireRegistered = opts?.requireRegisteredAgent === true;
  const auth = getRequestAuth(req);
  if (!auth) {
    return resolveAgentPrincipal(myAgentId, requireRegistered);
  }
  switch (auth.kind) {
    case "controller":
    case "guest":
      return { kind: "guest" };
    case "user":
      return { kind: "user", userId: auth.userId };
    case "agent":
      return resolveAgentPrincipal(auth.agentId, requireRegistered);
    case "operator":
      if (precedence === "agent-first" && myAgentId) {
        return resolveAgentPrincipal(myAgentId, requireRegistered);
      }
      return { kind: "operator" };
    default:
      return assertNever(auth);
  }
}

/**
 * The principal of a keyed HTTP request that may act as an agent. Workers share the swarm API
 * key, so the key alone authenticates as the operator. An X-Agent-ID, or an `aseph_` session
 * token, names the agent on top of it, and its lead flag is read live. A user token stays the
 * user. A request with no agent identity is the operator, as for the dashboard and the runner.
 * Unlike `requestPrincipal`, an agent identity wins over the operator key.
 */
export async function agentFirstPrincipal(
  req: IncomingMessage,
  myAgentId?: string,
  opts?: { fallback?: "operator" | "anonymous-agent" },
): Promise<RbacPrincipal> {
  const headerAgentId = myAgentId ?? singleHeader(req, "x-agent-id");
  const principal = await requestPrincipal(req, headerAgentId, {
    precedence: "agent-first",
  });
  if (principal) return principal;
  return opts?.fallback === "anonymous-agent"
    ? { kind: "agent", agentId: "", isLead: false }
    : { kind: "operator" };
}

/** Extract the authenticated user's id when the request carries user credentials. */
export function authUserId(auth: HttpRequestAuth | null | undefined): string | undefined {
  return auth?.kind === "user" ? auth.userId : undefined;
}

/** Extract the authenticated user record when the request carries user credentials. */
export function authUser(auth: HttpRequestAuth | null | undefined): User | undefined {
  return auth?.kind === "user" ? auth.user : undefined;
}

/** Narrow request auth to the shared operator key. */
export function isOperatorAuth(
  auth: HttpRequestAuth | null | undefined,
): auth is Extract<HttpRequestAuth, { kind: "operator" }> {
  return auth?.kind === "operator";
}

/**
 * Require the request's auth kind to be in `allowed`. Writes a 403 and returns
 * null when the request is unauthenticated or carries any other auth kind.
 */
export function requireAuthKind<K extends HttpRequestAuth["kind"]>(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly K[],
  forbiddenMessage = "Forbidden",
): Extract<HttpRequestAuth, { kind: K }> | null {
  const auth = getRequestAuth(req);
  if (auth && (allowed as readonly string[]).includes(auth.kind)) {
    return auth as Extract<HttpRequestAuth, { kind: K }>;
  }
  jsonError(res, forbiddenMessage, 403);
  return null;
}

/**
 * Refuse a guest page session on a handler that has no per-route guest rule.
 * Writes a 403 and returns true when the request is a guest's.
 */
export function rejectGuest(req: IncomingMessage, res: ServerResponse): boolean {
  if (getRequestAuth(req)?.kind !== "guest") return false;
  jsonError(res, "Forbidden", 403);
  return true;
}
