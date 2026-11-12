import { tasks } from "@trigger.dev/sdk";
import prisma from "../db.server";
import type { notifyExternalSystemTask } from "../trigger/notify-external-system";

export async function handleOrderCreated(shopId: bigint, order: { id: number }) {
  await prisma.$transaction(async (tx) => {
    await tx.shopifyOrder.create({ data: { id: BigInt(order.id), shopId } });
  });
  await tasks.trigger<typeof notifyExternalSystemTask>(
    "notify-external-system",
    { shopId: String(shopId), orderId: String(order.id) },
    { concurrencyKey: String(shopId), priority: 300, idempotencyKey: `order-created-${order.id}`, idempotencyKeyTTL: "1d" }
  );
}

export async function remindLater(shopId: string, orderId: string) {
  await tasks.trigger<typeof notifyExternalSystemTask>("notify-external-system", { shopId, orderId }, {
    concurrencyKey: shopId,
    priority: 0,
    delay: "7d",
    idempotencyKey: `remind-${orderId}`,
    idempotencyKeyTTL: "8d",
  });
}
