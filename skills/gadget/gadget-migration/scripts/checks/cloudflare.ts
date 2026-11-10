// Checks for apps moving to Cloudflare. references/platforms/cloudflare.md explains each one.
import { DOCS, type CheckModule } from "./types.ts";

const GUIDE = `${DOCS}/cloudflare`;

export const cloudflare: CheckModule = {
  platform: "cloudflare",
  title: "Cloudflare",
  detect: (repo) => repo.exists("wrangler.jsonc") || repo.exists("wrangler.json") || repo.exists("wrangler.toml") || "@cloudflare/vite-plugin" in repo.dependencies(),
  run: (repo) => {
    void GUIDE;
    void repo;
    return [];
  },
};
