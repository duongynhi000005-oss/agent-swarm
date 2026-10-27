import { describe, expect, test } from "bun:test";
import { QuickJSScriptExecutor } from "../scripts-runtime/executors/quickjs";
import { bundleForQuickJS } from "../scripts-runtime/executors/quickjs-bundle";
import type { ExecutorInput } from "../scripts-runtime/executors/types";
import { DEFAULT_SCRIPT_RESOURCES } from "../scripts-runtime/executors/types";

const executor = new QuickJSScriptExecutor();

function input(source: string, overrides: Partial<ExecutorInput> = {}): ExecutorInput {
  return {
    source,
    args: null,
    configPayload: {
      system: {
        apiKey: { value: "quickjs-zod-eval-test", isSecret: true },
        agentId: { value: "agent-zod", isSecret: false },
        mcpBaseUrl: { value: "http://127.0.0.1:1", isSecret: false },
      },
      user: {},
    },
    resources: { ...DEFAULT_SCRIPT_RESOURCES, wallClockMs: 5_000, ...overrides.resources },
    fsMode: "none",
    network: "open",
    ...overrides,
  };
}

describe("quickjs zod evaluation pruning (#2016)", () => {
  test("prunes unused classic zod schemas, JSON Schema processors, and JIT codegen from bundle", async () => {
    const source = `import { z } from "zod";
export const argsSchema = z.object({
  email: z.string().email(),
  n: z.number().int(),
});
export default async (args: z.infer<typeof argsSchema>) => args;
`;
    const bundle = await bundleForQuickJS(source);
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;

    // Without pruning, classic zod's ZodType/ZodString prototype couplings pull
    // ~96 KB into every bundle. Pruning keeps the bundle under 25 KB.
    expect(bundle.code.length).toBeLessThan(25_000);
    expect(bundle.code).not.toContain("createToJSONSchemaMethod");
    expect(bundle.code).not.toContain("$ZodObjectJIT");
    expect(bundle.code).not.toContain("ZodUUID");
    expect(bundle.code).not.toContain("ZodCIDRv6");
  });

  test("preserves referenced zod combinators, string/number checks, and parse variants", async () => {
    const source = `import { z } from "zod";
export const argsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  tags: z.string().min(2).array().optional(),
  nickname: z.string().nullish(),
  count: z.number().int().min(1).max(10).default(3),
  mode: z.literal("fast").or(z.literal("safe")),
}).refine((val) => val.count > 0, { message: "count must be positive" });

export default async (args: z.infer<typeof argsSchema>) => {
  const safe = z.number().positive().safeParse(args.count);
  const asyncCheck = await z.string().spa(args.email);
  return {
    args,
    safeOk: safe.success,
    asyncOk: asyncCheck.success,
    optFlag: z.string().optional().isOptional(),
  };
};
`;
    const ok = await executor.run(
      input(source, {
        args: { email: "  USER@Example.COM ", mode: "fast" },
      }),
    );
    expect(ok.error).toBeUndefined();
    expect(ok.exitCode).toBe(0);
    expect(ok.result).toEqual({
      args: {
        email: "user@example.com",
        tags: undefined,
        nickname: undefined,
        count: 3,
        mode: "fast",
      },
      safeOk: true,
      asyncOk: true,
      optFlag: true,
    });

    const bad = await executor.run(
      input(source, {
        args: { email: "not-an-email", count: 99, mode: "fast" },
      }),
    );
    expect(bad.error).toBe("eval_error");
    expect(bad.runtimeError?.message).toContain("argsSchema validation failed:");
    expect(bad.runtimeError?.message).toContain("email");
    expect(bad.runtimeError?.message).toContain("count");
  });

  test("retains toJSONSchema when explicitly referenced by the script", async () => {
    const source = `import { z } from "zod";
export default async () => {
  const schema = z.object({ name: z.string() });
  return schema.toJSONSchema();
};
`;
    const out = await executor.run(input(source));
    expect(out.error).toBeUndefined();
    expect(out.exitCode).toBe(0);
    expect(out.result).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  test("preserves cross-run isolation across consecutive zod script runs", async () => {
    const mutateSource = `import { z } from "zod";
export const argsSchema = z.object({ x: z.number() });
export default async (args: z.infer<typeof argsSchema>) => {
  (globalThis as any).__leaked_marker = "polluted";
  (Object.prototype as any).__leaked_proto = "polluted";
  (z as any).__leaked_zod = "polluted";
  return args.x + 1;
};
`;
    const checkSource = `import { z } from "zod";
export const argsSchema = z.object({ x: z.number() });
export default async (args: z.infer<typeof argsSchema>) => ({
  value: args.x * 2,
  globalLeak: typeof (globalThis as any).__leaked_marker,
  protoLeak: typeof ({} as any).__leaked_proto,
  zodLeak: typeof (z as any).__leaked_zod,
});
`;
    const first = await executor.run(input(mutateSource, { args: { x: 10 } }));
    expect(first.result).toBe(11);

    for (let i = 0; i < 4; i++) {
      const next = await executor.run(input(checkSource, { args: { x: 5 } }));
      expect(next.error).toBeUndefined();
      expect(next.result).toEqual({
        value: 10,
        globalLeak: "undefined",
        protoLeak: "undefined",
        zodLeak: "undefined",
      });
    }
  });
});
