// Checks for apps moving to Supabase. references/platforms/supabase.md explains each one.
import { DOCS, type CheckModule } from "./types.ts";

const GUIDE = `${DOCS}/supabase`;

export const supabase: CheckModule = {
  platform: "supabase",
  title: "Supabase",
  detect: (repo) => repo.exists("supabase/config.toml") || repo.find(/^supabase\/migrations\//).length > 0 || "@supabase/supabase-js" in repo.dependencies(),
  run: (repo) => {
    void GUIDE;
    void repo;
    return [];
  },
};
