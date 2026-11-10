import { task } from "@trigger.dev/sdk";
import { PrismaClient } from "@prisma/client";
import { externalLimit } from "./limits";

export const notifyExternalSystemTask = task({
  id: "notify-external-system",
  concurrency: { perKey: 2 },
  run: async (payload: { shopId: string; orderId: string }) => {
    const prisma = new PrismaClient();
    const order = await prisma.shopifyOrder.findUnique({ where: { id: BigInt(payload.orderId) } });
    await fetch("https://api.example.com/orders", { method: "POST", headers: { authorization: `Bearer ${process.env.EXTERNAL_API_TOKEN}` }, body: JSON.stringify(order) });
  },
  onFailure: async ({ payload }) => {
    console.error(`order ${payload.orderId} failed for good`);
  },
});

export const syncOrderTask = task({
  id: "sync-order",
  concurrency: externalLimit,
  run: async (payload: { shopId: string; orderId: string }) => {
    console.log(payload.orderId);
  },
});

export const refundOrderTask = task({
  id: "refund-order",
  concurrency: externalLimit,
  run: async (payload: { shopId: string; orderId: string }) => {
    console.log(payload.orderId);
  },
});
