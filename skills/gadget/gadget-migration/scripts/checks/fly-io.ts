// Checks for apps moving to Fly.io. references/platforms/fly-io.md explains each one.
import { DOCS, type CheckModule } from "./types.ts";

const GUIDE = `${DOCS}/fly-io`;

export const flyIo: CheckModule = {
  platform: "fly-io",
  title: "Fly.io",
  detect: (repo) => repo.find(/^fly(\.[\w-]+)?\.toml$/).length > 0,
  run: (repo) => {
    void GUIDE;
    void repo;
    return [];
  },
};
