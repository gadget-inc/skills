// Checks for apps moving to Railway. references/platforms/railway.md explains each one.
import { DOCS, type CheckModule } from "./types.ts";

const GUIDE = `${DOCS}/railway`;

export const railway: CheckModule = {
  platform: "railway",
  title: "Railway",
  detect: (repo) => repo.exists(".railway/railway.ts") || repo.exists("railway.json") || repo.exists("railway.toml"),
  run: (repo) => {
    void GUIDE;
    void repo;
    return [];
  },
};
