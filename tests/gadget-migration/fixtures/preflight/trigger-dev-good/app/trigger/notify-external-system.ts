import { task } from "@trigger.dev/sdk";
import prisma from "../db.server";
import { externalQueue } from "./limits";

export const notifyExternalSystemTask = task({
  id: "notify-external-system",
  concurrency: { perKey: 2 },
  run: async (payload: { shopId: string; orderId: string }) => {
    const order = await prisma.shopifyOrder.findUnique({ where: { id: BigInt(payload.orderId) } });
    console.log(order?.id);
  },
});

export const syncOrderTask = task({
  id: "sync-order",
  queue: externalQueue,
  run: async (payload: { shopId: string; orderId: string }) => {
    console.log(payload.orderId);
  },
});

export const refundOrderTask = task({
  id: "refund-order",
  queue: externalQueue,
  run: async (payload: { shopId: string; orderId: string }) => {
    console.log(payload.orderId);
  },
});
