import { applyParams, save, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";

export const run: ActionRun = async ({ params, record }) => {
  applyParams(params, record);
  await preventCrossShopDataAccess(params, record);
  await save(record);
};

// a model with a metafield field keeps its filter in the trigger, even on framework 1.7 and later
export const options: ActionOptions = {
  actionType: "update",
  triggers: {
    api: false,
    shopify: {
      webhooks: ["products/update"],
      shopifyFilter: 'vendor:"Nike Air" AND variants.price:>=10.00',
      includeFields: ["id", "updated_at", "vendor"],
    },
  },
};
