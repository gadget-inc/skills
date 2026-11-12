// Typechecks the TypeScript in aws.md with the AWS SDK clients and the Prisma client it uses.
// Run with: npm test (from this folder), which generates the Prisma client first
import { join } from "node:path";
import { describe, it } from "node:test";
import { typecheck, writeProject } from "../platform-blocks.ts";

const here = import.meta.dirname;

describe("aws.md TypeScript", () => {
  it("typechecks with @aws-sdk/client-sqs and client-scheduler 3.1167.0, Prisma 6.19.3, and TypeScript 5.9.3", () => {
    const roots = writeProject("aws.md", join(here, ".typecheck", "project"), {
      // the template's db.server.ts, so the job's transaction is typed
      "app/db.server.ts": 'import { PrismaClient } from "@prisma/client";\n\nconst prisma = new PrismaClient();\nexport default prisma;\n',
    });
    typecheck(here, roots, { types: ["node"] });
  });
});
