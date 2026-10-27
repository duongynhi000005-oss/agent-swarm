import { block, modify, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({
  blockedSource: z.string().optional(),
  blockedSubstring: z.string().optional(),
  prefix: z.string().optional(),
  mode: z.enum(["steer", "queue"]).optional(),
});

const manifest = {
  name: "steer-gate",
  description: "Filters or rewrites steering messages before delivery",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.task.steer", (event, ctx) => {
    if (ctx.config.blockedSource && event.source === ctx.config.blockedSource) {
      return block(`Steering source ${ctx.config.blockedSource} is blocked`);
    }
    if (ctx.config.blockedSubstring && event.message.includes(ctx.config.blockedSubstring)) {
      return block(`Steering message contains blocked text "${ctx.config.blockedSubstring}"`);
    }
    const nextMessage = ctx.config.prefix ? `${ctx.config.prefix}${event.message}` : undefined;
    if (nextMessage !== undefined || ctx.config.mode !== undefined) {
      return modify({
        ...(nextMessage !== undefined ? { message: nextMessage } : {}),
        ...(ctx.config.mode !== undefined ? { mode: ctx.config.mode } : {}),
      });
    }
  });
};

export default extension;
