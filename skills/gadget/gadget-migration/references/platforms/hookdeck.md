# Hookdeck

## What is this?

Hookdeck receives Shopify's webhooks, answers Shopify, and delivers each one to your app with retries, so the app's route can do the work before it responds. Gadget's guide has the setup: https://docs.gadget.dev/guides/moving-to-another-platform/hookdeck. Read [common.md](common.md) first. [shopify-webhooks.md](../shopify-webhooks.md) covers the Shopify source, path forwarding, the retry and deduplicate rules, and both signature checks; this file adds checks, failure signatures, and the code for moving stores one at a time, delivery groups, and the `processed_webhook` cleanup.

## Checks to run

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform hookdeck
```

| Check | What it catches |
|---|---|
| `hookdeck/source-webhook-secret` | `--source-webhook-secret` in a setup script. For a Shopify source it checks a header Shopify never sends. |
| `hookdeck/destination-path` | A `--destination-url` with a path while the URIs in `shopify.app.toml` carry one too, which Hookdeck doubles. One route for every topic, with the bare source URL as every URI and the path only in the destination, passes. |
| `hookdeck/dedupe-window-seconds` | A deduplicate window of 3600 or less, which Hookdeck reads as milliseconds. |
| `hookdeck/retry-5xx-only` | A retry rule limited to `5xx`, so a `404` from a wrong path never retries. |
| `hookdeck/transform-rule` | A transformation on a Shopify connection, which breaks the HMAC. |
| `hookdeck/filter-replaces-rules` | `hookdeck gateway connection upsert` with a filter flag and no retry flag. It replaces the whole rules array. |
| `hookdeck/filter-syntax` | A shop filter written as a plain array (matches nothing) or with `$in`, `$startsWith`, or `$endsWith` (matches substrings). |
| `hookdeck/hand-written-filter` | Store domains written into a filter by hand, where two sides can drift apart. |
| `hookdeck/toml-uri` | An `hkdk.events` URI with `<source-id>` left in, or with no path after the source id while the destination URL has none either or other URIs have one. With no destination in the repository, a bare URI is an error only when the app has several webhook routes. |
| `hookdeck/body-before-hmac` | A route that parses or re-serializes the body before Shopify's HMAC check. |
| `hookdeck/no-hookdeck-signature` | A webhook route behind Hookdeck that doesn't check `x-hookdeck-signature`. |
| `hookdeck/processed-webhook` | No table of processed webhook ids, or no job that deletes old rows. |
| `hookdeck/connection-audit` | A reminder: the connection's real settings live in Hookdeck. Run the audit below. |

What the script can't see:

- **The connections as Hookdeck has them.** `HOOKDECK_API_KEY=... node scripts/hookdeck.ts audit` reports a source that isn't `SHOPIFY`, a missing retry or deduplicate rule, a window in seconds, a transform rule, a destination path, path forwarding left on toward Gadget, auth other than Hookdeck's signature, and a paused connection.
- **Webhooks Hookdeck rejected.** After the first real webhook, `hookdeck gateway request list --rejection-cause VERIFICATION_FAILED --output json` should list nothing.
- **A store's webhooks still on their way to Gadget.** `node scripts/hookdeck.ts pending store-a.myshopify.com` lists the store's events on the Gadget connections that are queued, waiting for a retry, held, or failed.
- **Throughput.** Every plan delivers 5 events per second per destination unless you raise it. The project's [Quotas](https://dashboard.hookdeck.com/settings/project/quotas) page shows yours, and a delivery policy above it has no effect.
- **The header prefix.** A custom prefix in the project settings renames `x-hookdeck-signature`, and the route's check then rejects every delivery. Keep the default.
- **Cleanup against retention.** `select min(received_at), count(*) from processed_webhook;` should show nothing older than the cleanup's window, and that window must be longer than the plan's retention: 3 days on Developer, 7 on Team, 30 on Growth.

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| Requests rejected with `VERIFICATION_FAILED`, and Shopify reports failed deliveries | The source has the wrong secret, such as the development app's, or was made with `--source-webhook-secret` | The source setup in [shopify-webhooks.md](../shopify-webhooks.md) |
| `404` for `/webhooks/orders/updated/webhooks/orders/updated` | The destination URL has the path too | Origin only in the destination URL (`hookdeck/destination-path`) |
| Your route answers `401` to every delivery, and `x-hookdeck-signature` is missing | The destination's auth isn't Hookdeck Signature, the only one that sends the header, or the project uses a custom header prefix | Set the destination's auth to Hookdeck Signature and keep the `x-hookdeck` prefix |
| Your route answers `401` to every delivery, and the header is there | `HOOKDECK_WEBHOOK_SECRET` is another project's, such as development's | Use the signing secret of the project this destination is in |
| `TypeError: Body is unusable: Body has already been read` | The route read the body, such as with `request.json()`, before `authenticate.webhook` | Verify first, then use the payload it returns (`hookdeck/body-before-hmac`) |
| `TypeError: unusable` from `request.clone()` | The clone came after the body was read | Clone before any read, as the guide's route does |
| A side effect runs twice for webhooks minutes apart, with a deduplicate rule in place | The window is in seconds: `3600` is 3.6 seconds | `"window": 3600000` |
| Failed deliveries stop retrying after a filter change | A CLI filter update replaced the rules array, dropping the retry rule | Write filters with `scripts/hookdeck.ts filters`, which keeps the other rules ([Move one store at a time](https://docs.gadget.dev/guides/moving-to-another-platform/hookdeck#move-one-store-at-a-time)) |
| After a filter change, no webhook reaches the new app, and the requests show as discarded | The filter is a plain array of domains, which only matches a value containing all of them | `$or` of exact domains (`hookdeck/filter-syntax`) |
| A store that hasn't moved gets webhooks in the new app | `$in` matched part of its domain | `$or` of exact domains |
| A store's webhooks still reach Gadget after you moved it | A filter change applies only to webhooks Hookdeck receives after it | Expected. Wait with `scripts/hookdeck.ts pending` ([Move one store at a time](https://docs.gadget.dev/guides/moving-to-another-platform/hookdeck#move-one-store-at-a-time)) |
| Events with the error code `CANCELLED_PAST_RETENTION` | They outlived the plan's retention and can't be retried | Reconcile those stores ([shopify-sync.md](../shopify-sync.md)) |
| Events with the error code `TIMEOUT` | The route took longer than the destination's delivery timeout, 60 seconds by default | Speed up the route, or raise the timeout and keep the host's above it |
| A delivery group named **Unknown** | Events with no `x-shopify-shop-domain` header, or received before grouping was turned on | Expected for those events |
| A Gadget connection's test event gets Gadget's `404` with `cannot handle topic orders/updated for shop` | The sample's store isn't in your Gadget app | Expected: the connection reaches Gadget. Any other response means it doesn't |

## Complete examples

### The moved-store table

The guide says to keep the list of moved stores in one place and write every filter from it. This is that place, plus the index the cleanup job needs:

```sql
-- in db/migrations/hookdeck_store_cutover.sql
-- the stores whose webhooks go to the new app; scripts/hookdeck.ts writes every connection's filter from it
create table moved_store (
  shop_domain text primary key check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  moved_at timestamptz not null default now()
);

-- the cleanup deletes by age; without an index each run scans the whole table. Run outside a transaction.
create index concurrently if not exists processed_webhook_received_at_idx on processed_webhook (received_at);
```

The check constraint turns a typo such as `Store-A.myshopify.com ` into an error at insert, instead of a store whose webhooks go nowhere.

### Filters, audit, pending events, and delivery groups

One script, with Prisma from Shopify's template for the table. `filters` prints what it would write; `filters --apply` writes it and reads back what Hookdeck stored:

```typescript
// in scripts/hookdeck.ts
// HOOKDECK_API_KEY=... node scripts/hookdeck.ts audit | filters [--apply] | pending <shop-domain> | groups <destination-id> --apply
// The API key is the project's, from its Secrets settings. Each environment has its own project.
import prisma from "../app/db.server";

// the new app's connection, and for a store-by-store move, one connection to Gadget per subscription,
// with the path of the new app's matching subscription. Leave GADGET empty if every store moves at once.
const NEW_APP = "shopify-to-new-app";
const GADGET: Record<string, string> = { "shopify-to-gadget-orders-updated": "/webhooks/orders/updated" };

type Rule = { type: string } & Record<string, unknown>;
interface Connection {
  id: string;
  name: string | null;
  rules: Rule[];
  paused_at: string | null;
  disabled_at: string | null;
  source: { type: string };
  destination: { id: string; config?: { url?: string; path_forwarding_disabled?: boolean; auth_type?: string | null; delivery_timeout?: number | null } };
}

async function hookdeck<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  // HOOKDECK_API_URL is only for pointing tests at a stand-in
  const response = await fetch(`${process.env.HOOKDECK_API_URL ?? "https://api.hookdeck.com/2026-09-01"}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${process.env.HOOKDECK_API_KEY}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

const connections = async () => (await hookdeck<{ models: Connection[] }>("/connections?limit=255")).models;
const canonical = (v: unknown): string => (v && typeof v === "object" ? Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}` : JSON.stringify(v));

// Both sides' filters from one list, so every store is in exactly one of them.
export function storeFilters(moved: string[]) {
  const domains = [...new Set(moved.map((d) => d.trim().toLowerCase()))].sort();
  const bad = domains.filter((d) => !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d));
  if (bad.length) throw new Error(`not a myshopify.com domain: ${bad.join(", ")}`);
  // Hookdeck documents no meaning for an empty $or, so the list starts with your own test store
  if (!domains.length) throw new Error("no moved stores: insert your test store into moved_store first");
  const match = { "x-shopify-shop-domain": { $or: domains } };
  return { newApp: { type: "filter", headers: match } as Rule, gadget: (path: string): Rule => ({ type: "filter", path, headers: { $not: match } }) };
}

// A PUT with rules replaces the whole array, so swap the filter and keep the retry and deduplicate rules.
export const withFilter = (rules: Rule[], filter: Rule) => (rules.some((r) => r.type === "filter") ? rules.map((r) => (r.type === "filter" ? filter : r)) : [filter, ...rules]);

export async function writeFilters(moved: string[], apply = false) {
  const { newApp, gadget } = storeFilters(moved);
  const byName = new Map((await connections()).map((c) => [c.name, c]));
  const out: string[] = [];
  for (const [name, filter] of [[NEW_APP, newApp], ...Object.entries(GADGET).map(([n, path]) => [n, gadget(path)])] as [string, Rule][]) {
    const connection = byName.get(name);
    if (!connection) throw new Error(`no Hookdeck connection named ${name}`);
    if (!connection.rules.some((r) => r.type === "retry")) throw new Error(`${name} has no retry rule: add one before writing filters`);
    const rules = withFilter(connection.rules, filter);
    if (!apply) {
      out.push(`${name}: ${JSON.stringify(rules)}`);
      continue;
    }
    const saved = await hookdeck<Connection>(`/connections/${connection.id}`, { method: "PUT", body: { rules } });
    if (canonical(saved.rules) !== canonical(rules)) throw new Error(`${name}: Hookdeck stored different rules than the ones sent`);
    out.push(`${name}: wrote ${moved.length} stores`);
  }
  return out;
}

export async function audit() {
  const problems: string[] = [];
  const all = await connections();
  for (const name of [NEW_APP, ...Object.keys(GADGET)]) {
    const c = all.find((x) => x.name === name);
    const say = (problem: string) => problems.push(`${name}: ${problem}`);
    if (!c) {
      say("no such connection");
      continue;
    }
    const retry = c.rules.find((r) => r.type === "retry");
    const dedupe = c.rules.find((r) => r.type === "deduplicate");
    const config = c.destination.config ?? {};
    const toGadget = name in GADGET;
    if (c.source.type !== "SHOPIFY") say(`source type ${c.source.type} doesn't check Shopify's signature`);
    if (c.paused_at || c.disabled_at) say("paused or disabled");
    if (!retry) say("no retry rule");
    else if (Array.isArray(retry.response_status_codes) && retry.response_status_codes.every((s) => /^(5|>=?5|>499)/.test(String(s)))) say(`retries only ${retry.response_status_codes.join(", ")}`);
    if (!dedupe) say("no deduplicate rule");
    else if (Number(dedupe.window) <= 3600) say(`deduplicate window is ${dedupe.window} ms`);
    if (c.rules.some((r) => r.type === "transform")) say("a transform rule breaks Shopify's HMAC");
    if (Object.keys(GADGET).length && !c.rules.some((r) => r.type === "filter")) say("no store filter");
    if (toGadget && !config.path_forwarding_disabled) say("path forwarding is on, so Gadget gets the path added to its URL");
    if (!toGadget && config.url && new URL(config.url).pathname !== "/") say(`destination URL has the path ${new URL(config.url).pathname}`);
    if (!toGadget && config.auth_type !== "HOOKDECK_SIGNATURE") say(`destination auth ${config.auth_type} sends no x-hookdeck-signature`);
  }
  return problems;
}

// A store's events on the Gadget connections that haven't been delivered. Empty means step 4 can go on to Gadget's Queues page.
export async function pending(shop: string) {
  const ids = (await connections()).filter((c) => c.name !== null && c.name in GADGET).map((c) => c.id);
  const headers = encodeURIComponent(JSON.stringify({ "x-shopify-shop-domain": shop }));
  const events: { id: string; status: string }[] = [];
  for (const id of ids) {
    for (const status of ["QUEUED", "SCHEDULED", "HOLD", "FAILED"]) {
      events.push(...(await hookdeck<{ models: { id: string; status: string }[] }>(`/events?webhook_id=${id}&status=${status}&headers=${headers}&limit=255`)).models);
    }
  }
  return events;
}

// Each store gets its own queue at groupRate a second. period "concurrent" caps simultaneous deliveries
// instead of a rate, which fits a database pool; groups only take rates.
export async function setDeliveryPolicy(destinationId: string, { rate = 20, period = "second", groupRate = 2 } = {}) {
  const { url, path_forwarding_disabled, delivery_timeout } = (await hookdeck<{ config: NonNullable<Connection["destination"]["config"]> }>(`/destinations/${destinationId}`)).config;
  const delivery_policy = { rate, period, groups: { key: "headers.x-shopify-shop-domain", rate: groupRate, rate_period: "second" } };
  // the schema requires url, so send the destination's own settings back with the policy
  const config = { url, delivery_policy, ...(path_forwarding_disabled !== undefined && { path_forwarding_disabled }), ...(delivery_timeout && { delivery_timeout }) };
  return hookdeck(`/destinations/${destinationId}`, { method: "PUT", body: { config } });
}

if (process.argv[1]?.endsWith("hookdeck.ts")) {
  const [command, arg] = process.argv.slice(2);
  const apply = process.argv.includes("--apply");
  if (command === "filters") {
    const rows = await prisma.$queryRaw<{ shop_domain: string }[]>`select shop_domain from moved_store order by shop_domain`;
    console.log((await writeFilters(rows.map((r) => r.shop_domain), apply)).join("\n"));
  } else if (command === "audit") {
    const problems = await audit();
    console.log(problems.join("\n") || "no problems found");
    process.exitCode = problems.length ? 1 : 0;
  } else if (command === "pending") console.log(await pending(arg));
  else if (command === "groups" && apply) console.log(await setDeliveryPolicy(arg));
  else console.error("usage: node scripts/hookdeck.ts audit | filters [--apply] | pending <shop-domain> | groups <destination-id> --apply");
  await prisma.$disconnect();
}
```

Before a store's first filter write, the Gadget connections need the same retry rule as the new app's and path forwarding turned off, as the guide says; `audit` reports both.

### The `processed_webhook` cleanup

[shopify-webhooks.md](../shopify-webhooks.md) records each webhook id in `processed_webhook` (the guide names the column `processed_at` where the skill uses `received_at`). Behind Hookdeck a row has to outlive the plan's retention, because a bulk retry within that window would otherwise run the work again:

```typescript
// in app/jobs/prune-processed-webhooks.server.ts
// run daily, such as at 0 3 * * *, from your host's cron or your queue's scheduler
import prisma from "../db.server";

export async function pruneProcessedWebhooks(retentionDays = Number(process.env.HOOKDECK_RETENTION_DAYS), batchSize = 10_000) {
  // 3 days on Developer, 7 on Team, 30 on Growth
  if (!Number.isInteger(retentionDays) || retentionDays < 3) throw new Error("set HOOKDECK_RETENTION_DAYS to your Hookdeck plan's retention in days");
  // shopify-webhooks.md keeps a week; keep whichever is longer, plus a day
  const keepDays = Math.max(retentionDays, 7) + 1;
  let deleted = 0;
  for (;;) {
    // small batches keep each delete's locks and write-ahead log short
    const n = await prisma.$executeRaw`
      delete from processed_webhook
      where webhook_id in (
        select webhook_id from processed_webhook
        where received_at < now() - make_interval(days => ${keepDays}::int)
        limit ${batchSize}::int
      )`;
    deleted += n;
    if (n < batchSize) return deleted;
  }
}

if (process.argv[1]?.endsWith("prune-processed-webhooks.server.ts")) {
  console.log(`deleted ${await pruneProcessedWebhooks()} processed_webhook rows`);
  await prisma.$disconnect();
}
```

## Cutover

The order in [cutover.md](../cutover.md) and the guide's [Cut over to the new platform](https://docs.gadget.dev/guides/moving-to-another-platform/hookdeck#cut-over-to-the-new-platform) hold. With the script, each step of [Move one store at a time](https://docs.gadget.dev/guides/moving-to-another-platform/hookdeck#move-one-store-at-a-time) becomes:

- **Step 1, load its records:** as the guide says.
- **Steps 2 and 3, stop its webhooks to Gadget and send them to the new app:** `insert into moved_store (shop_domain) values ('store-a.myshopify.com');`, then `node scripts/hookdeck.ts filters --apply`. One run writes both sides from the same list.
- **Step 4, wait for Gadget:** repeat `node scripts/hookdeck.ts pending store-a.myshopify.com` until it prints `[]`, retry or note any `FAILED` events, then wait for Gadget's Queues page as the guide says.
- **Steps 5 and 6, move its tokens and reconcile it:** as the guide says.

Before the token move, a store moves back with `delete from moved_store where shop_domain = '...'` and another `filters --apply`. After it, the store stays: only one app may hold its tokens. Before a deploy that would fail webhooks for a while, pause the connection, as the guide's [Keep Shopify data in sync](https://docs.gadget.dev/guides/moving-to-another-platform/hookdeck#keep-shopify-data-in-sync) describes.

## What wasn't verified

No Hookdeck account was used. `scripts/hookdeck.ts` ran against a local stand-in for Hookdeck's API, which checked every request body against the schemas in Hookdeck's OpenAPI document for API version `2026-09-01`: the filter, retry, and deduplicate rules, the connection `PUT`, and the destination `PUT`. The filters were evaluated with an implementation of the [filter syntax](https://hookdeck.com/docs/filters#filter-syntax) as documented, which showed each store in exactly one side's filter, a plain array matching no store, and `$in` matching a substring. The cleanup job ran against Postgres 18.6, and the body errors were reproduced with Node's `Request`.

Not checked against Hookdeck itself: what an empty `$or` does (the script refuses to write one), how large a filter Hookdeck accepts with hundreds of domains, whether header names in filters are case-sensitive, how the events endpoint expects a list of statuses (the script asks for one at a time), what path a path filter sees, and which `Host` header a delivery to Gadget carries. That the CLI's filter flags replace the rules array comes from the `hookdeck-cli` v3.1.0 source, and that the header is only sent with Hookdeck Signature auth comes from Hookdeck's [destinations](https://hookdeck.com/docs/destinations#headers) page.
