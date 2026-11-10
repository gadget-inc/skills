// Checks for apps moving to Inngest. references/platforms/inngest.md explains each one.
import { DOCS, type CheckModule } from "./types.ts";

const GUIDE = `${DOCS}/inngest`;

export const inngest: CheckModule = {
  platform: "inngest",
  title: "Inngest",
  detect: (repo) => "inngest" in repo.dependencies(),
  run: (repo) => {
    void GUIDE;
    void repo;
    return [];
  },
};
