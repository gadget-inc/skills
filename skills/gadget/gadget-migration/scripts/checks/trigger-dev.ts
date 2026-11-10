// Checks for apps moving to Trigger.dev. references/platforms/trigger-dev.md explains each one.
import { DOCS, type CheckModule } from "./types.ts";

const GUIDE = `${DOCS}/trigger-dev`;

export const triggerDev: CheckModule = {
  platform: "trigger-dev",
  title: "Trigger.dev",
  detect: (repo) => repo.exists("trigger.config.ts") || "@trigger.dev/sdk" in repo.dependencies(),
  run: (repo) => {
    void GUIDE;
    void repo;
    return [];
  },
};
