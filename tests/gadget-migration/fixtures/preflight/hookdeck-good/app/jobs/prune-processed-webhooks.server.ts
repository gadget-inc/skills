import prisma from "../db.server";

export async function pruneProcessedWebhooks(keepDays: number) {
  return prisma.$executeRaw`delete from processed_webhook where received_at < now() - make_interval(days => ${keepDays}::int)`;
}
