// stands in for the reference's Prisma service, which needs a database
export async function pruneAuditLogs(executionId: string) {
  return `pruned for ${executionId}`;
}
