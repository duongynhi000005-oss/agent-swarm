import { SourceMapReader } from "./sourcemap";

/**
 * Bundles a user script for the quickjs executor. QuickJS runs plain
 * JavaScript only, so Bun strips the types and inlines the imports into one
 * IIFE. The bundle sets `globalThis.__swarm_module` to the module namespace.
 *
 * Bare imports:
 *  - `zod` is inlined from its ESM sources, so Bun tree-shakes it. Each run
 *    evaluates only the zod code that the script uses.
 *  - `stdlib` and `swarm-sdk` resolve to small virtual modules that read the
 *    sandbox globals the quickjs runner installs.
 */

export const USER_SCRIPT_FILE = "user-script.ts";
const VIRTUAL_DIR = "/swarm-virtual";
const ENTRY_PATH = `${VIRTUAL_DIR}/entry.ts`;
const USER_PATH = `${VIRTUAL_DIR}/${USER_SCRIPT_FILE}`;

const STDLIB_MODULE = `const s = globalThis.__swarm_stdlib;
export const fetch = s.fetch;
export const fetchJson = s.fetchJson;
export const glob = s.glob;
export const grep = s.grep;
export const table = s.table;
export const Redacted = s.Redacted;
`;

const SWARM_SDK_MODULE = `export function createSwarmSdk() {
  return globalThis.__swarm_ctx.swarm;
}
`;

export type QuickJSBundle =
  | { ok: true; code: string; map: SourceMapReader | undefined }
  | { ok: false; diagnostic: string };

type BuildConfigWithFiles = Parameters<typeof Bun.build>[0] & { files: Record<string, string> };

const zodEntryCache = new Map<string, string | null>();
const zodSourceCache = new Map<string, string>();

async function readCachedZodSource(filePath: string): Promise<string> {
  const cached = zodSourceCache.get(filePath);
  if (cached !== undefined) return cached;
  const text = await Bun.file(filePath).text();
  zodSourceCache.set(filePath, text);
  return text;
}

/**
 * Extracts identifiers referenced by user script source so classic `zod` can
 * shed unused format classes, combinators, codecs, and JSON Schema generators
 * before `Bun.build` runs dead-code elimination.
 */
function collectUsedIdentifiers(source: string): ReadonlySet<string> {
  const set = new Set(source.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
  // Every swarm script contains `export default`, so only keep the `default`
  // schema builder when `.default` or `_default` is referenced.
  if (!/(?:\.\s*default\b|\b_default\b|["']default["'])/.test(source)) {
    set.delete("default");
  }
  return set;
}

function pruneClassicZodExternal(text: string, used: ReadonlySet<string>): string {
  let out = text;
  if (!used.has("locales")) {
    out = out.replace(/^\s*export \* as locales from "\.\.\/locales\/index\.js";\s*$/gm, "");
  }
  if (!used.has("fromJSONSchema")) {
    out = out.replace(/^\s*export \{ fromJSONSchema \} from "\.\/from-json-schema\.js";\s*$/gm, "");
  }
  if (!used.has("toJSONSchema")) {
    out = out.replace(
      /^\s*export \{ toJSONSchema \} from "\.\.\/core\/json-schema-processors\.js";\s*$/gm,
      "",
    );
  }
  return out;
}

function pruneClassicZodSchemas(text: string, used: ReadonlySet<string>): string {
  let out = text;
  if (!used.has("toJSONSchema") && !used.has("jsonSchema")) {
    out = out.replace(
      /Object\.assign\(inst\["~standard"\],\s*\{\s*jsonSchema:\s*\{[\s\S]*?\},\s*\}\);\s*inst\.toJSONSchema\s*=\s*createToJSONSchemaMethod\(inst,\s*\{\}\);/,
      "",
    );
    out = out.replace(/^\s*inst\._zod\.processJSONSchema\s*=[^;]+;\s*$/gm, "");
  }
  // Use $ZodObject instead of $ZodObjectJIT inside QuickJS: single-shot
  // argsSchema.parse runs do not benefit from dynamic `new Function` codegen.
  out = out.replace(
    "core.$ZodObjectJIT.init(inst, def);",
    () => "core.$ZodObject.init(inst, def);",
  );
  if (!used.has("spa")) {
    out = out.replace(/^\s*inst\.spa\s*=\s*inst\.safeParseAsync;\s*$/gm, "");
  }
  out = out.replace(
    /^\s*inst\.(safeParse|parseAsync|safeParseAsync|encode|decode|encodeAsync|decodeAsync|safeEncode|safeDecode|safeEncodeAsync|safeDecodeAsync)\s*=\s*(?:async\s*)?\([^;]+;\s*$/gm,
    (line, method: string) => {
      if (method === "safeParse" && (used.has("isOptional") || used.has("isNullable"))) {
        return line;
      }
      if (method === "safeParseAsync" && used.has("spa")) {
        return line;
      }
      return used.has(method) ? line : "";
    },
  );
  out = out.replace(
    /^\s*inst\.([a-zA-Z0-9_]+)\s*=\s*\((?:params|\.\.\.args)?\)\s*=>\s*inst\.check\([^;]+\);\s*$/gm,
    (line, method: string) => (used.has(method) ? line : ""),
  );
  out = out.replace(
    /^\s{8}([a-zA-Z0-9_]+)\([^)]*\)\s*\{\s*\n(?:\s{12}.*\n)*?\s{8}\},\n/gm,
    (block, method: string) => {
      if (method === "check" || method === "with" || method === "clone") return block;
      return used.has(method) ? block : "";
    },
  );
  return out;
}

/**
 * Prefer zod's real ESM sources, which tree-shake well. The prebuilt
 * `zod.bundle.js` of the API image barely tree-shakes (~340 KB against ~87 KB
 * for z.object + z.string().email()), so it is only the last fallback.
 */
export async function resolveZodEntry(
  moduleName: "zod" | "zod/mini" = "zod",
): Promise<string | null> {
  const runtimeDir = process.env.SCRIPT_RUNTIME_DIR;
  const cacheKey = `${runtimeDir ?? ""}:${moduleName}`;
  if (zodEntryCache.has(cacheKey)) return zodEntryCache.get(cacheKey)!;
  const esmPath = moduleName === "zod" ? "index.js" : "mini/index.js";
  const bundleName = moduleName === "zod" ? "zod" : "zod-mini";
  const candidates: Array<() => string | undefined> = [
    () => (runtimeDir ? `${runtimeDir}/zod-esm/${esmPath}` : undefined),
    () => Bun.resolveSync(moduleName, import.meta.dir),
    () => (runtimeDir ? `${runtimeDir}/${bundleName}.bundle.js` : undefined),
  ];
  for (const candidate of candidates) {
    try {
      const path = candidate();
      if (path && (await Bun.file(path).exists())) {
        zodEntryCache.set(cacheKey, path);
        return path;
      }
    } catch {
      // Try the next candidate. Bun.resolveSync throws inside the compiled binary.
    }
  }
  zodEntryCache.set(cacheKey, null);
  return null;
}

const CACHE_LIMIT = 128;
const cache = new Map<string, QuickJSBundle>();

function remember(key: string, bundle: QuickJSBundle): QuickJSBundle {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, bundle);
  return bundle;
}

export async function bundleForQuickJS(source: string): Promise<QuickJSBundle> {
  const key = Bun.hash(source).toString(36);
  const cached = cache.get(key);
  if (cached) {
    // Refresh the LRU position.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const usedIdentifiers = /\bzod\b/.test(source) ? collectUsedIdentifiers(source) : null;
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [ENTRY_PATH],
      // In-memory sources (Bun >= 1.3). The pinned bun-types predate the option.
      files: {
        [ENTRY_PATH]: `import * as m from "./${USER_SCRIPT_FILE}";\nglobalThis.__swarm_module = m;\n`,
        [USER_PATH]: source,
      },
      format: "iife",
      target: "browser",
      sourcemap: "external",
      // Less source for QuickJS to parse on every run. Identifiers stay, so
      // stack frames keep their function names; the source map keeps lines.
      minify: { whitespace: true, syntax: true, identifiers: false },
      plugins: [
        {
          name: "swarm-script-imports",
          setup(build) {
            build.onResolve({ filter: /^(stdlib|swarm-sdk)$/ }, (args) => ({
              path: args.path,
              namespace: "swarm-virtual",
            }));
            build.onLoad({ filter: /.*/, namespace: "swarm-virtual" }, (args) => ({
              contents: args.path === "stdlib" ? STDLIB_MODULE : SWARM_SDK_MODULE,
              loader: "js",
            }));
            build.onResolve({ filter: /^zod(?:\/mini)?$/ }, async (args) => {
              const zodEntry = await resolveZodEntry(args.path as "zod" | "zod/mini");
              if (!zodEntry) {
                throw new Error(
                  `${args.path} is not available to the quickjs executor in this deployment`,
                );
              }
              return { path: zodEntry };
            });
            if (usedIdentifiers) {
              build.onLoad({ filter: /v4[\\/]classic[\\/]external\.js$/ }, async (args) => ({
                contents: pruneClassicZodExternal(
                  await readCachedZodSource(args.path),
                  usedIdentifiers,
                ),
                loader: "js",
              }));
              build.onLoad({ filter: /v4[\\/]classic[\\/]schemas\.js$/ }, async (args) => ({
                contents: pruneClassicZodSchemas(
                  await readCachedZodSource(args.path),
                  usedIdentifiers,
                ),
                loader: "js",
              }));
            }
          },
        },
      ],
    } as BuildConfigWithFiles);
  } catch (error) {
    // Bun.build throws an AggregateError for syntax and resolve errors.
    const messages =
      error instanceof AggregateError
        ? error.errors.map((entry) => String(entry?.message ?? entry))
        : [error instanceof Error ? error.message : String(error)];
    return { ok: false, diagnostic: messages.join("\n") };
  }

  if (!result.success) {
    return {
      ok: false,
      diagnostic: result.logs.map((log) => String(log.message ?? log)).join("\n"),
    };
  }

  const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
  if (!output) return { ok: false, diagnostic: "quickjs bundle produced no entry point" };
  const code = await output.text();
  const mapArtifact = result.outputs.find((artifact) => artifact.kind === "sourcemap");
  const map = mapArtifact ? new SourceMapReader(JSON.parse(await mapArtifact.text())) : undefined;
  return remember(key, { ok: true, code, map });
}
