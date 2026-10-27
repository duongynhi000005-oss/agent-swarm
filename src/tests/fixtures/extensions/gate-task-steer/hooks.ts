import { block, modify, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({
  blockContaining: z.string().optional(),
  rewritePrefix: z.string().optional(),
});

const manifest = {
  name: "gate-task-steer",
  description: "Continues, rewrites, or blocks task steering messages",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.task.steer", (event, ctx) => {
    if (ctx.config.blockContaining && event.message.includes(ctx.config.blockContaining)) {
      return block(`Steering containing "${ctx.config.blockContaining}" is blocked`);
    }
    if (ctx.config.rewritePrefix) {
      return modify({ message: `${ctx.config.rewritePrefix}${event.message}` });
    }
  });
};

export default extension;
