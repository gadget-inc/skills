import { Render } from "@renderinc/sdk";

const render = new Render();

// starts every store's run at once: on Hobby, Render accepts 50 a minute and rejects the rest with a 429
export async function startAllReconciliations(shopIds: string[], day: string) {
  await Promise.all(
    shopIds.map((shopId) => render.workflows.startTask("my-app-workflows/reconcileShop", [shopId], { idempotencyKey: `reconcile-${shopId}-${day}` }))
  );
}
