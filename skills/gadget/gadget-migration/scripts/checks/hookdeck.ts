// Checks for apps moving to Hookdeck. references/platforms/hookdeck.md explains each one.
import { DOCS, type CheckModule } from "./types.ts";

const GUIDE = `${DOCS}/hookdeck`;

export const hookdeck: CheckModule = {
  platform: "hookdeck",
  title: "Hookdeck",
  detect: (repo) => repo.sourceFiles().some((f) => /x-hookdeck-signature/.test(repo.read(f) ?? "")) || repo.find(/(^|\/)shopify\.app(\.[\w-]+)?\.toml$/).some((f) => /hkdk\.events/.test(repo.read(f) ?? "")),
  run: (repo) => {
    void GUIDE;
    void repo;
    return [];
  },
};
