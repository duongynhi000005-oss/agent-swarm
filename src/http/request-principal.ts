import type { IncomingMessage, ServerResponse } from "node:http";
import { getAgentById } from "../be/db";
import type { RbacPrincipal } from "../rbac";
import type { User } from "../types";
import { getRequestAuth, type HttpRequestAuth } from "../utils/request-auth-context";
import { jsonError } from "./utils";

export type HttpAuthKind = HttpRequestAuth["kind"];
export type PrincipalPrecedence = "operator-first" | "agent-first";
export type UnauthenticatedPrincipalFallback = "null" | "operator" | "empty-agent";

export interface ResolvePrincipalOptions {
  precedence?: PrincipalPrecedence;
  unauthenticated?: UnauthenticatedPrincipalFallback;
  requireRegisteredAgent?: boolean;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled HttpRequestAuth kind: ${JSON.stringify(value)}`);
}

/** Extract the authenticated user id when the request carries user auth. */
export function authUserId(auth: HttpRequestAuth | null | undefined): string | undefined {
  return auth?.kind === "user" ? auth.userId : undefined;
}

/** Extract the authenticated User record when the request carries user auth. */
export function authUser(auth: HttpRequestAuth | null | undefined): User | undefined {
  return auth?.kind === "user" ? auth.user : undefined;
}

/** Narrow or check whether the request carries operator auth. */
export function isOperatorAuth(
  auth: HttpRequestAuth | null | undefined,
): auth is Extract<HttpRequestAuth, { kind: "operator" }> {
  return auth?.kind === "operator";
}

/** Resolve the agent id from an agent session token, falling back to a header-supplied id. */
export function authAgentId(
  auth: HttpRequestAuth | null | undefined,
  fallbackAgentId?: string,
): string | undefined {
  return auth?.kind === "agent" ? auth.agentId : fallbackAgentId;
}

/** Type guard checking whether `auth` has one of the allowed `HttpRequestAuth` kinds. */
export function hasAuthKind<K extends HttpAuthKind>(
  auth: HttpRequestAuth | null | undefined,
  allowed: readonly K[],
): auth is Extract<HttpRequestAuth, { kind: K }> {
  return auth != null && (allowed as readonly string[]).includes(auth.kind);
}

/**
 * Central HTTP request-auth to `RbacPrincipal` resolver.
 *
 * Uses an exhaustive `switch (auth.kind)` with an `assertNever` default so adding
 * a new `HttpRequestAuth` variant is a compile error in one place.
 */
export async function resolveHttpPrincipal(
  req: IncomingMessage,
  myAgentId: string | undefined,
  options: ResolvePrincipalOptions & {
    unauthenticated: "operator" | "empty-agent";
    requireRegisteredAgent?: false;
  },
): Promise<RbacPrincipal>;
export async function resolveHttpPrincipal(
  req: IncomingMessage,
  myAgentId?: string | undefined,
  options?: ResolvePrincipalOptions,
): Promise<RbacPrincipal | null>;
export async function resolveHttpPrincipal(
  req: IncomingMessage,
  myAgentId?: string | undefined,
  options?: ResolvePrincipalOptions,
): Promise<RbacPrincipal | null> {
  const precedence = options?.precedence ?? "operator-first";
  const unauthenticated = options?.unauthenticated ?? "null";
  const requireRegisteredAgent = options?.requireRegisteredAgent ?? false;

  const resolveAgent = async (agentId: string): Promise<RbacPrincipal | null> => {
    const agent = await getAgentById(agentId);
    if (!agent && requireRegisteredAgent) return null;
    return { kind: "agent", agentId, isLead: agent?.isLead === true };
  };

  const auth = getRequestAuth(req);
  if (auth) {
    switch (auth.kind) {
      case "controller":
      case "guest":
        return { kind: "guest" };
      case "user":
        return { kind: "user", userId: auth.userId };
      case "agent": {
        const effectiveAgentId =
          precedence === "operator-first" ? (myAgentId ?? auth.agentId) : auth.agentId;
        if (!effectiveAgentId) return null;
        return resolveAgent(effectiveAgentId);
      }
      case "operator": {
        if (precedence === "agent-first" && myAgentId) {
          return resolveAgent(myAgentId);
        }
        return { kind: "operator" };
      }
      default:
        return assertNever(auth);
    }
  }

  if (myAgentId) {
    return resolveAgent(myAgentId);
  }
  if (unauthenticated === "operator") return { kind: "operator" };
  if (unauthenticated === "empty-agent") return { kind: "agent", agentId: "", isLead: false };
  return null;
}

/**
 * The RBAC principal of an HTTP request, for a handler-side `can()` check.
 * Operator and user request auth win over the X-Agent-ID header (an operator
 * bearer with any agent id stays the operator). An agent id that is not
 * registered is a non-lead agent. Null when the request has neither.
 */
export async function requestPrincipal(
  req: IncomingMessage,
  myAgentId: string | undefined,
): Promise<RbacPrincipal | null> {
  return resolveHttpPrincipal(req, myAgentId, {
    precedence: "operator-first",
    unauthenticated: "null",
  });
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
  myAgentId: string | undefined,
): Promise<RbacPrincipal> {
  return resolveHttpPrincipal(req, myAgentId, {
    precedence: "agent-first",
    unauthenticated: "operator",
  });
}

/**
 * Require the request's auth to match one of `allowed`. Writes a 403 and
 * returns null when unauthenticated or when `auth.kind` is not in `allowed`.
 */
export function requireAuthKind<K extends HttpAuthKind>(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly K[],
  forbiddenMessage = "Forbidden",
): Extract<HttpRequestAuth, { kind: K }> | null {
  const auth = getRequestAuth(req);
  if (!hasAuthKind(auth, allowed)) {
    jsonError(res, forbiddenMessage, 403);
    return null;
  }
  return auth;
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
