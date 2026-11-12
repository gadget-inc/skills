import { ActionOptions } from "gadget-server";

export const run: ActionRun = async ({ logger, connections }) => {
  const shopify = await connections.shopify.forShopId("1");
  logger.info({ shopify: Boolean(shopify) }, "pruning");
};

export const options: ActionOptions = {
  // don't move this into business hours: it locks the audit log table
  timeoutMS: 900000,
  triggers: { api: false, scheduler: [{ every: "day", at: "02:00 UTC" }] },
};
