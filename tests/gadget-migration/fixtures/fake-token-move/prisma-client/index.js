// A stand-in for @prisma/client with only the template's Session model, kept in the JSON file
// FAKE_SESSIONS so it survives from one run of the script to the next.
// FAKE_DIE_AFTER_SESSION: the process exits right after it saves that store's session, which is
// before the script clears Gadget's refresh token.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const read = () => (existsSync(process.env.FAKE_SESSIONS) ? JSON.parse(readFileSync(process.env.FAKE_SESSIONS, "utf8")) : {});

export class PrismaClient {
  session = {
    async findUnique({ where }) {
      return read()[where.id] ?? null;
    },
    async create({ data }) {
      const sessions = read();
      if (sessions[data.id]) throw new Error("Unique constraint failed on the fields: (`id`)");
      sessions[data.id] = data;
      writeFileSync(process.env.FAKE_SESSIONS, JSON.stringify(sessions));
      if (process.env.FAKE_DIE_AFTER_SESSION === data.shop) process.exit(1);
      return data;
    },
  };
}
