// A stand-in for a generated @gadget-client package, used by data-export.test.ts. It serves
// FAKE_TOTAL records in id order, 250 at most per request, the way the Internal API pages, and
// appends every request it receives to FAKE_CALL_LOG.
//
// FAKE_FAIL_CALLS: comma-separated request numbers (counted across restarts) that throw.
// FAKE_DIE_AFTER_PAGE: the process exits when the script reads that page's endCursor, which is
// after it appended the page to the output and before it saved the checkpoint.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const total = Number(process.env.FAKE_TOTAL ?? 0);
const failCalls = new Set((process.env.FAKE_FAIL_CALLS ?? "").split(",").filter(Boolean).map(Number));
const dieAfterPage = Number(process.env.FAKE_DIE_AFTER_PAGE ?? 0);
const callLog = process.env.FAKE_CALL_LOG;

const priorCalls = () => (existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean).length : 0);

function manager(model) {
  return {
    async findMany(options = {}) {
      const call = priorCalls() + 1;
      appendFileSync(callLog, JSON.stringify({ model, ...options }) + "\n");
      if (failCalls.has(call)) throw new Error("GGT_TOO_MANY_REQUESTS: rate limit exceeded");
      if (options.first > 250) throw new Error("first can't be greater than 250");

      const start = options.after ? Number(options.after) : 0;
      const end = Math.min(total, start + (options.first ?? 50));
      const page = [];
      for (let id = start + 1; id <= end; id++) page.push({ id: String(id), name: `record "${id}" \\ ünï`, updatedAt: "2026-11-07T00:00:00.000Z" });
      const pageNumber = Math.ceil(end / 250);
      Object.defineProperty(page, "hasNextPage", { value: end < total });
      Object.defineProperty(page, "endCursor", {
        get() {
          if (dieAfterPage === pageNumber && priorCalls() === pageNumber) process.exit(1);
          return String(end);
        },
      });
      return page;
    },
  };
}

export class Client {
  constructor(options) {
    if (options?.environment !== "Production" || !options?.authenticationMode?.apiKey) throw new Error("expected a production API key client");
    this.internal = { widget: manager("widget"), billing: { invoice: manager("billing/invoice") } };
  }
}
