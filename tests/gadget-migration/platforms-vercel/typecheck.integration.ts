// Type-checks every TypeScript block in references/platforms/vercel.md, with the Prisma client generated
// from the reference's ScheduleRun model and the template's app/db.server.ts.
import { describe, it } from "node:test";
import { join } from "node:path";
import { typecheck, writeProject } from "../platform-blocks.ts";
import { generatePrisma, here } from "./prisma.ts";

const TEMPLATE_DB = `import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;
`;

describe("vercel.md TypeScript blocks", () => {
  it("typecheck", () => {
    generatePrisma();
    const roots = writeProject("vercel.md", join(here, ".typecheck"), { "app/db.server.ts": TEMPLATE_DB });
    typecheck(here, roots, {});
  });
});
