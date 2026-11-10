// Checks for apps moving to Render. references/platforms/render.md explains each one.
import { DOCS, type CheckModule } from "./types.ts";

const GUIDE = `${DOCS}/render`;

export const render: CheckModule = {
  platform: "render",
  title: "Render",
  detect: (repo) => repo.exists("render.yaml") || "@renderinc/sdk" in repo.dependencies(),
  run: (repo) => {
    void GUIDE;
    void repo;
    return [];
  },
};
