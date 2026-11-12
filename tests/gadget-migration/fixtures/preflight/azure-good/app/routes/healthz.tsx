// in app/routes/healthz.tsx
// The web app's HTTP readiness probe: a revision that can't reach the database never takes traffic.
import prisma from "../db.server";

export const loader = async () => {
  await prisma.$queryRaw`select 1`;
  return new Response("ok");
};
