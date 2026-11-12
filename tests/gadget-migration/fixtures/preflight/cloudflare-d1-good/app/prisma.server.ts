import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "@prisma/client";
import { env } from "cloudflare:workers";

// a client per request, on the D1 binding
export const prisma = () => new PrismaClient({ adapter: new PrismaD1(env.DB) });
