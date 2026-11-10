import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

export default defineConfig({
  project: "proj_abc123",
  dirs: ["./app/trigger"],
  maxDuration: 900,
  retries: {
    default: { maxAttempts: 7, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 60_000, randomize: false },
  },
  build: {
    extensions: [prismaExtension({ mode: "legacy", schema: "prisma/schema.prisma" })],
  },
});
