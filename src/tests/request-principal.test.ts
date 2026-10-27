import { describe, expect, test } from "bun:test";
import { type IncomingMessage, ServerResponse } from "node:http";
import {
  agentFirstPrincipal,
  authUser,
  authUserId,
  isOperatorAuth,
  requestPrincipal,
  requireAuthKind,
} from "../http/request-principal";
import type { User } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";

const fakeReq = () => ({ headers: {} }) as unknown as IncomingMessage;

const sampleUser: User = {
  id: "user-1",
  name: "Alice",
  email: "alice@example.com",
  role: "member",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("requestPrincipal and agentFirstPrincipal", () => {
  test("operator-first vs agent-first precedence for operator key with X-Agent-ID", async () => {
    const req = fakeReq();
    setRequestAuth(req, { kind: "operator", fingerprint: "fp" });

    expect(await requestPrincipal(req, undefined)).toEqual({ kind: "operator" });
    expect(await requestPrincipal(req, "unregistered-agent")).toEqual({ kind: "operator" });
    expect(await requestPrincipal(req, "unregistered-agent", { precedence: "agent-first" })).toEqual(
      {
        kind: "agent",
        agentId: "unregistered-agent",
        isLead: false,
      },
    );
    expect(
      await requestPrincipal(req, "unregistered-agent", {
        precedence: "agent-first",
        requireRegisteredAgent: true,
      }),
    ).toBeNull();
    expect(await agentFirstPrincipal(req, "unregistered-agent")).toEqual({
      kind: "agent",
      agentId: "unregistered-agent",
      isLead: false,
    });
  });

  test("maps user, guest, controller, and agent tokens across both precedences", async () => {
    const userReq = fakeReq();
    setRequestAuth(userReq, { kind: "user", userId: sampleUser.id, user: sampleUser });
    expect(await requestPrincipal(userReq, "ignored-agent")).toEqual({
      kind: "user",
      userId: sampleUser.id,
    });
    expect(
      await requestPrincipal(userReq, "ignored-agent", { precedence: "agent-first" }),
    ).toEqual({
      kind: "user",
      userId: sampleUser.id,
    });

    const guestReq = fakeReq();
    setRequestAuth(guestReq, { kind: "guest" });
    expect(await requestPrincipal(guestReq, "ignored-agent")).toEqual({ kind: "guest" });
    expect(await agentFirstPrincipal(guestReq, "ignored-agent")).toEqual({ kind: "guest" });

    const ctrlReq = fakeReq();
    setRequestAuth(ctrlReq, {
      kind: "controller",
      controllerId: "ctrl-1",
      tokenId: "tok-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(await requestPrincipal(ctrlReq, undefined)).toEqual({
      kind: "guest",
    });

    const agentReq = fakeReq();
    setRequestAuth(agentReq, {
      kind: "agent",
      tokenKind: "agent",
      agentId: "tok-agent",
      taskId: null,
      runtimeId: null,
      tokenId: "tok-2",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(await requestPrincipal(agentReq, "header-agent")).toEqual({
      kind: "agent",
      agentId: "tok-agent",
      isLead: false,
    });
  });

  test("unauthenticated direct handler fallback modes", async () => {
    const req = fakeReq();
    expect(await agentFirstPrincipal(req, undefined)).toEqual({ kind: "operator" });
    expect(await agentFirstPrincipal(req, undefined, { fallback: "anonymous-agent" })).toEqual({
      kind: "agent",
      agentId: "",
      isLead: false,
    });
  });
});

describe("requireAuthKind and field accessors", () => {
  test("narrows allowed kinds and writes 403 for disallowed kinds", () => {
    const opReq = fakeReq();
    setRequestAuth(opReq, { kind: "operator", fingerprint: "fp" });
    const opRes = new ServerResponse(opReq);
    const narrowed = requireAuthKind(opReq, opRes, ["operator", "user"], "Denied");
    expect(narrowed?.kind).toBe("operator");
    expect(isOperatorAuth(narrowed)).toBe(true);
    expect(authUserId(narrowed)).toBeUndefined();
    expect(authUser(narrowed)).toBeUndefined();

    const userReq = fakeReq();
    setRequestAuth(userReq, { kind: "user", userId: sampleUser.id, user: sampleUser });
    const userRes = new ServerResponse(userReq);
    const narrowedUser = requireAuthKind(userReq, userRes, ["user"], "User required");
    expect(narrowedUser?.kind).toBe("user");
    expect(isOperatorAuth(narrowedUser)).toBe(false);
    expect(authUserId(narrowedUser)).toBe(sampleUser.id);
    expect(authUser(narrowedUser)).toEqual(sampleUser);

    const guestReq = fakeReq();
    setRequestAuth(guestReq, { kind: "guest" });
    const guestRes = new ServerResponse(guestReq);
    expect(requireAuthKind(guestReq, guestRes, ["operator", "user"], "Denied")).toBeNull();
    expect(guestRes.statusCode).toBe(403);
  });
});
