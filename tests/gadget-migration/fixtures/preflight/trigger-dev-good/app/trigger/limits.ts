import { queue } from "@trigger.dev/sdk";

export const externalQueue = queue({ name: "external", concurrencyLimit: 2 });
