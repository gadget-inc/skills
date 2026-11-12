// A stand-in for a generated @gadget-client package, used by shopify-token-move.test.ts. It serves
// the shopifyShop records in the JSON file FAKE_SHOPS, 50 at most per request, and appends every
// update it receives to FAKE_UPDATE_LOG. An update changes the file, so a second run sees it.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const read = () => JSON.parse(readFileSync(process.env.FAKE_SHOPS, "utf8"));

export class Client {
  constructor(options) {
    if (options?.environment !== "Production" || !options?.authenticationMode?.apiKey) throw new Error("expected a production API key client");
    this.internal = {
      shopifyShop: {
        async findMany(options = {}) {
          if (options.filter?.state?.inState !== "created.installed") throw new Error("expected a filter on installed stores");
          const shops = read();
          const start = options.after ? Number(options.after) : 0;
          const end = Math.min(shops.length, start + (options.first ?? 50));
          const page = shops.slice(start, end);
          Object.defineProperty(page, "hasNextPage", { value: end < shops.length });
          Object.defineProperty(page, "endCursor", { value: String(end) });
          return page;
        },
        async update(id, changes) {
          appendFileSync(process.env.FAKE_UPDATE_LOG, JSON.stringify({ id, changes }) + "\n");
          writeFileSync(process.env.FAKE_SHOPS, JSON.stringify(read().map((shop) => (shop.id === id ? { ...shop, ...changes } : shop))));
        },
      },
    };
  }
}
