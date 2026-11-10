// Writes prisma/schema.prisma from the Session model in Shopify's template plus the ScheduleRun model in
// references/platforms/vercel.md, and generates the client, so the tests run the model the reference shows.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { block } from "../platform-blocks.ts";

export const here = fileURLToPath(new URL(".", import.meta.url));

export function generatePrisma() {
  const model = block("vercel.md", "prisma/schema.prisma").split("\n").slice(1).join("\n");
  const schema = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DATABASE_URL_UNPOOLED")
}

model Session {
  id          String    @id
  shop        String
  state       String
  isOnline    Boolean   @default(false)
  scope       String?
  expires     DateTime?
  accessToken String
}

${model}`;
  mkdirSync(join(here, "prisma"), { recursive: true });
  writeFileSync(join(here, "prisma/schema.prisma"), schema);
  execFileSync(join(here, "node_modules/.bin/prisma"), ["generate", "--schema", "prisma/schema.prisma"], { cwd: here, stdio: "pipe" });
}
