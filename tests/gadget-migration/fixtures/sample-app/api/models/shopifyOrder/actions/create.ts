import { applyParams, save, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";

export const run: ActionRun = async ({ params, record }) => {
  applyParams(params, record);
  await preventCrossShopDataAccess(params, record);
  if (record.changed("totalPrice")) record.reviewed = false;
  await save(record);
};

export const onSuccess: ActionOnSuccess = async ({ record, api }) => {
  await api.enqueue(
    api.notifyExternalSystem,
    { orderId: record.id },
    { queue: { name: `external-${record.shopId}`, maxConcurrency: 2 }, retries: 3, id: `order-${record.id}` }
  );
};

export const options: ActionOptions = {
  actionType: "create",
  triggers: { api: false, shopify: { webhooks: ["orders/create"] } },
};
