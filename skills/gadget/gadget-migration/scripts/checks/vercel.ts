// Checks for apps moving to Vercel. references/platforms/vercel.md explains each one.
import { DOCS, type CheckModule } from "./types.ts";

const GUIDE = `${DOCS}/vercel`;

export const vercel: CheckModule = {
  platform: "vercel",
  title: "Vercel",
  detect: (repo) => repo.exists("vercel.json") || repo.exists(".vercel/project.json") || "@vercel/react-router" in repo.dependencies() || "@vercel/functions" in repo.dependencies(),
  run: (repo) => {
    void GUIDE;
    void repo;
    return [];
  },
};
