import prisma from "./db.server";

// every query for a store runs in a transaction that sets the store first
export function forShop<T>(shopId: bigint, work: (tx: any) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`select set_config('app.shop_id', ${String(shopId)}, true)`;
    return work(tx);
  });
}
