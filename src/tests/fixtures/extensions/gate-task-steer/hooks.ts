import { block, modify, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({
  blockedPhrase: z.string().optional().default("drop-steer"),
  prefix: z.string().optional(),
});

const manifest = {
  name: "gate-task-steer",
  description: "Gates and rewrites task steering messages",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.task.steer", (event, ctx) => {
    if (ctx.config.blockedPhrase && event.message.includes(ctx.config.blockedPhrase)) {
      return block(`Steering message contains blocked phrase "${ctx.config.blockedPhrase}"`);
    }
    if (ctx.config.prefix) {
      return modify({ message: `${ctx.config.prefix}${event.message}` });
    }
  });
};

export default extension;
