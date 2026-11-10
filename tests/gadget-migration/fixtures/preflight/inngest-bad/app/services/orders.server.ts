import prisma from "../db.server";
import { inngest } from "../inngest.server";

export async function handleOrderCreated(shopId: bigint, order: { id: number; total_price: string }) {
  await prisma.$transaction(async (tx) => {
    await tx.shopifyOrder.create({ data: { id: BigInt(order.id), shopId, totalPrice: order.total_price } });
    await inngest.send({
      name: "app/order.created",
      data: { shopId, orderId: String(order.id) },
    });
  });
}

export async function resendOrder(orderId: string) {
  await inngest.send({ name: "app/order.created", data: { orderId } });
}
