import { Inngest } from "inngest";
import prisma from "./db.server";
import { notifyExternalSystem } from "./services/external.server";
import { auditOrderPage } from "./services/audit.server";
import { deleteAuditLogsOlderThan } from "./services/audit-logs.server";

export const inngest = new Inngest({ id: "my-app", checkpointing: { maxRuntime: "4m" } });

export const notifyExternalSystemFn = inngest.createFunction(
  {
    id: "notify-external-system",
    triggers: [{ event: "app/order.created" }],
    concurrency: [{ key: "event.data.shopId", limit: 2 }],
    priority: { run: "event.data.priority == 'high' ? 600 : event.data.priority == 'low' ? 0 : 300" },
    retries: 6,
  },
  async ({ event, step }) => {
    const order = await step.run("load-order", () => prisma.shopifyOrder.findUnique({ where: { id: BigInt(event.data.orderId) } }));
    await step.run("notify", () => notifyExternalSystem(String(order?.id)));
  }
);

export const auditStoreOrders = inngest.createFunction(
  { id: "audit-store-orders", triggers: [{ event: "app/orders.audit" }], concurrency: { scope: "env", key: '"audit-" + event.data.shopId', limit: 1 } },
  async ({ event, step }) => {
    await step.run("page-1", () => auditOrderPage(event.data.shopId, null));
  }
);

export const pruneAuditLogs = inngest.createFunction(
  { id: "prune-audit-logs", triggers: [{ cron: "0 2 * * *" }], singleton: { mode: "skip" } },
  async ({ step }) => {
    await step.run("delete-old-audit-logs", () => deleteAuditLogsOlderThan(90));
  }
);

export const functions = [
  notifyExternalSystemFn,
  auditStoreOrders,
  ...(process.env.INNGEST_SCHEDULES === "on" ? [pruneAuditLogs] : []),
];
