import { concurrencyLimit } from "@trigger.dev/sdk";

export const externalLimit = concurrencyLimit({ name: "external", perKey: 2 });
