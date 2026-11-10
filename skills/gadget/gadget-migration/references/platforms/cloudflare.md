# Cloudflare

## What is this?

On Cloudflare the app runs as a Worker, a function Cloudflare starts for each request or event, with Postgres outside Cloudflare reached through Hyperdrive, Workflows and Queues for background actions, Cron Triggers for scheduled actions, and R2 for files. Each Wrangler environment, such as `staging`, deploys as a separate Worker with its own bindings, the objects through which a Worker reaches those services. Gadget's guide: https://docs.gadget.dev/guides/moving-to-another-platform/cloudflare

Read [common.md](common.md) first.

## Checks to run

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform cloudflare
```

| Check | What it catches | How to check by hand |
|---|---|---|
| `cloudflare/entry-pipeable-stream`, `cloudflare/prisma-client`, `cloudflare/postgres-session-storage` | The three template files that expect Node: `entry.server.tsx`, Prisma's default client, and the session storage | |
| `cloudflare/module-scope-client` | A `pg` or `postgres` client created when the module loads | |
| `cloudflare/kv-session-storage`, `cloudflare/long-running-worker` | Shopify sessions in Workers KV, and a BullMQ `Worker`, which needs a process that never stops. With Containers, or a Fly.io, Render, Railway, or Cloud Run config beside `wrangler.jsonc`, the worker can run there, so it's a warning | |
| `cloudflare/env-not-inherited` | Bindings, `vars`, or `secrets` at the top of the file that an environment leaves out | `npx wrangler deploy --dry-run --env staging` warns for each, and `npx wrangler secret list --env production` should list every name in `secrets.required` |
| `cloudflare/shared-resource-name` | One queue, Workflow, bucket, Hyperdrive id, D1 id, or KV id in two environments | `npx wrangler queues info my-app-external` names one consumer, `my-app-production` |
| `cloudflare/build-env-mismatch` | A script that builds for one environment and deploys another with `--env`, or passes `--env` and builds with no `CLOUDFLARE_ENV`. A script that builds with no `CLOUDFLARE_ENV` at all is meant to run as `CLOUDFLARE_ENV=staging npm run deploy`, so it's a warning only when `vite.config.ts` doesn't stop such a build, as the one below does | After `CLOUDFLARE_ENV=production react-router build`, `npx wrangler deploy --dry-run` lists what would deploy |
| `cloudflare/types-without-env`, `cloudflare/types-strict-vars` | `wrangler types` without `--env`, or with literal types for a var the template's `vite.config.ts` assigns | |
| `cloudflare/no-placement`, `cloudflare/cron-weekday`, `cloudflare/queue-max-retries`, `cloudflare/webhook-waituntil`, `cloudflare/r2-dev-url` | Hyperdrive with no `placement`, a numeric weekday in a cron (1 is Sunday), a consumer on the default 3 retries, webhook work in `waitUntil`, and public files on `r2.dev` | |
| `cloudflare/crons-before-cutover` | Cron Triggers, which run from the deploy that adds them | The Worker's Settings > Trigger events in the dashboard. Locally, `curl -X POST "http://localhost:5173/cdn-cgi/handler/scheduled?cron=0+2+*+*+*"` runs that cron's handler |
| `cloudflare/hyperdrive-caching` | Hyperdrive's 60-second read cache | `npx wrangler hyperdrive get <id>` shows `"caching": { "disabled": true }` |
| `cloudflare/r2-cors` | Presigned uploads with no CORS rule on the bucket | `npx wrangler r2 bucket cors list my-app-files` |

## Failure signatures

Every row was reproduced locally with Wrangler 4.160.0 and the Cloudflare Vite plugin 1.68.0, except where the row says otherwise.

| You see | Cause | Fix |
|---|---|---|
| `Error: No such module "assets/.prisma/client/default".` on every request | The template's Prisma client | Node-postgres through Hyperdrive, or Prisma with `@prisma/adapter-pg` ([Run Shopify's app template on Workers](https://docs.gadget.dev/guides/moving-to-another-platform/cloudflare#run-shopify-s-app-template-on-workers)) |
| `TypeError: server_browserExports.renderToPipeableStream is not a function` | The template's `entry.server.tsx` | The entry file below |
| `Disallowed operation called within global scope. Asynchronous I/O (ex: fetch() or connect()), setting a timeout, and generating random values are not allowed within global scope.` | A `pg` `Client` created when a module loads, which fails every route because all routes share one server build. A `PostgreSQLSessionStorage` created there fails every request that uses it | Open clients inside a handler ([Connect through Hyperdrive](https://docs.gadget.dev/guides/moving-to-another-platform/cloudflare#connect-through-hyperdrive)) |
| `The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.` on the second request | A client opened in one request and kept for the next | A client per request, closed in `finally` |
| `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` | `PostgreSQLSessionStorage` created per call on an empty database: 10 of 10 concurrent first calls failed in Node | The guide's `workerSessionStorage` |
| `Detected an empty appUrl configuration` under `vite dev` | Every var is inside an environment and `CLOUDFLARE_ENV` isn't set | The `vite.config.ts` below |
| OAuth and redirects go to `https://staging.example.com` while you test through the `shopify app dev` tunnel | The Worker reads its vars and `.dev.vars`, never the shell. Not even `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` passes the CLI's `SHOPIFY_APP_URL` through | The `vite.config.ts` below, and the development app's secret in `.dev.vars` ([Run your app locally](https://docs.gadget.dev/guides/moving-to-another-platform/cloudflare#run-your-app-locally)) |
| `When developing locally, you should use a local Postgres connection string to emulate Hyperdrive functionality.`, or `You must provide a password - e.g. 'user:password@database.example.com:port/databasename'` | No local database for the Hyperdrive binding, or one without a password | `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://postgres:postgres@127.0.0.1:5432/my_app`, with a password |
| `"hyperdrive" exists at the top level, but not on "env.staging".` | Environments don't inherit bindings, `vars`, or `secrets` | Repeat them in each environment |
| `` You have specified the environment "production" via the `--env/-e` CLI argument. This does not match the target environment "staging" that was used when building the application. `` | A staging build deployed with `--env production` | `CLOUDFLARE_ENV=production react-router build`, then `wrangler deploy` with no `--env` |
| `No bindings found.` in `wrangler deploy`'s output | A build without `CLOUDFLARE_ENV` deploys the top-level Worker, `my-app` | Build with `CLOUDFLARE_ENV` |
| `error TS18048: 'env.HYPERDRIVE' is possibly 'undefined'.` | `wrangler types` without `--env` | `wrangler types --env production --strict-vars=false` |
| `vite.config.ts: error TS2322: Type 'string' is not assignable to type '"https://app.example.com"'.` | `wrangler types` gave `SHOPIFY_APP_URL` its literal value, and the template's `vite.config.ts` assigns it | Add `--strict-vars=false` |
| `Wrangler detected an AWS S3 CORS configuration format.` | A `CORSRules` file passed to `wrangler r2 bucket cors set` | The `rules` format below |
| `403` with `SignatureDoesNotMatch` from a browser upload | The upload's `Content-Type` or size differs from what the URL signed. Reproduced against an S3-compatible server, not R2 | Send the type the server signed, from the same `File` |
| `WorkflowTimeoutError: Execution timed out after 2000ms`, with the step's timeout in place of 2000, on every attempt | A step past its timeout, 10 minutes by default. From the guide's fact-check | Set `timeout` on the step ([Check your host's time limits](https://docs.gadget.dev/guides/moving-to-another-platform/cloudflare#check-your-host-s-time-limits)) |

## Complete examples

These files run Shopify's React Router template on Workers with node-postgres, next to the guide's [`withDb`](https://docs.gadget.dev/guides/moving-to-another-platform/cloudflare#connect-through-hyperdrive), `workerSessionStorage`, `ShopGate`, `ProcessWebhook`, and `ReconcileShop`. Built for staging and served by the Vite plugin against local Postgres, the app answered two deliveries of one webhook with `200` and ran one Workflow, the `0 2 * * *` cron deleted 12,000 old `audit_log` rows in 5,000-row steps, and the hourly cron started one `ReconcileShop` per store.

### `wrangler.jsonc`

The guide's file plus what it leaves out: `triggers`, the Shopify vars, and the R2 endpoint. `wrangler deploy --dry-run` accepts each environment's build. Deploy each with `CLOUDFLARE_ENV=production react-router build && wrangler deploy` after your migrations run over the database's own connection string, and type it with `wrangler types --env production --strict-vars=false`:

```jsonc
// in wrangler.jsonc
{
  "name": "my-app",
  "main": "./workers/app.ts",
  "compatibility_date": "2026-11-01",
  // every environment inherits the keys from here to "triggers". Bindings and vars are not inherited.
  "placement": { "region": "aws:us-east-1" },
  "limits": { "cpu_ms": 300000 },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShopGate"] }],
  "triggers": { "crons": [] }, // inherited too, so an environment runs no schedules until it lists its own
  "env": {
    "production": {
      "routes": [{ "pattern": "app.example.com", "custom_domain": true }],
      // add these in the cutover's "Move scheduled work" deploy. "crons": [] turns them off, deleting the key doesn't
      "triggers": { "crons": ["0 2 * * *", "0 * * * *"] },
      "vars": { "APP_ENV": "production", "SHOPIFY_APP_URL": "https://app.example.com", "SHOPIFY_API_KEY": "<production client_id>", "SCOPES": "write_products", "R2_ENDPOINT": "https://<account id>.r2.cloudflarestorage.com", "R2_BUCKET": "my-app-files" },
      "secrets": { "required": ["SHOPIFY_API_SECRET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] },
      "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<production Hyperdrive id>" }],
      "workflows": [
        { "binding": "PROCESS_WEBHOOK", "name": "my-app-process-webhook", "class_name": "ProcessWebhook" },
        { "binding": "RECONCILE_SHOP", "name": "my-app-reconcile-shop", "class_name": "ReconcileShop" },
        { "binding": "PRUNE_AUDIT_LOGS", "name": "my-app-prune-audit-logs", "class_name": "PruneAuditLogs" }
      ],
      "queues": { "producers": [{ "binding": "EXTERNAL_QUEUE", "queue": "my-app-external" }], "consumers": [{ "queue": "my-app-external", "max_batch_size": 1, "max_retries": 6 }] },
      "r2_buckets": [{ "binding": "FILES", "bucket_name": "my-app-files" }],
      "durable_objects": { "bindings": [{ "name": "SHOP_GATE", "class_name": "ShopGate" }] }
    },
    "staging": {
      "routes": [{ "pattern": "staging.example.com", "custom_domain": true }],
      "triggers": { "crons": ["0 2 * * *", "0 * * * *"] },
      "vars": { "APP_ENV": "staging", "SHOPIFY_APP_URL": "https://staging.example.com", "SHOPIFY_API_KEY": "<staging client_id>", "SCOPES": "write_products", "R2_ENDPOINT": "https://<account id>.r2.cloudflarestorage.com", "R2_BUCKET": "my-app-staging-files" },
      "secrets": { "required": ["SHOPIFY_API_SECRET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] },
      "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<staging Hyperdrive id>" }],
      "workflows": [
        { "binding": "PROCESS_WEBHOOK", "name": "my-app-staging-process-webhook", "class_name": "ProcessWebhook" },
        { "binding": "RECONCILE_SHOP", "name": "my-app-staging-reconcile-shop", "class_name": "ReconcileShop" },
        { "binding": "PRUNE_AUDIT_LOGS", "name": "my-app-staging-prune-audit-logs", "class_name": "PruneAuditLogs" }
      ],
      "queues": { "producers": [{ "binding": "EXTERNAL_QUEUE", "queue": "my-app-staging-external" }], "consumers": [{ "queue": "my-app-staging-external", "max_batch_size": 1, "max_retries": 6 }] },
      "r2_buckets": [{ "binding": "FILES", "bucket_name": "my-app-staging-files" }],
      "durable_objects": { "bindings": [{ "name": "SHOP_GATE", "class_name": "ShopGate" }] }
    }
  }
}
```

### `workers/app.ts`

The entry file: React Router for requests, the guide's queue consumer as `consumeExternal(batch, env)`, and one `scheduled` handler for both crons. Write `PruneAuditLogs` like the guide's Workflows, with one `step.do` per batch of a few thousand deletes, so a retry repeats one batch and no statement nears Hyperdrive's 60-second limit:

```typescript
// in workers/app.ts
import { createRequestHandler } from "react-router";
import { withDb } from "../app/db.server";
import type { ExternalJob } from "../app/services/external.server";
import { consumeExternal } from "./external-consumer";

// Cloudflare finds Durable Object and Workflow classes by name among this file's exports
export { ShopGate } from "./shop-gate";
export { ProcessWebhook } from "./workflows/process-webhook";
export { ReconcileShop } from "./workflows/reconcile-shop";
export { PruneAuditLogs } from "./workflows/prune-audit-logs";

declare module "react-router" {
  export interface AppLoadContext { cloudflare: { env: Env; ctx: ExecutionContext } }
}

// the app's modules load inside the first request, where opening connections is allowed
const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);
// Workflow instance ids allow letters, digits, hyphens, and underscores, up to 100 characters, so a shop's dots become hyphens
const instanceId = (...parts: string[]) => parts.join("-").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
// createBatch reports a repeated id as error 10405 instead of throwing. Anything else fails the handler.
async function start<P>(workflow: Workflow<P>, instances: WorkflowInstanceCreateOptions<P>[]) {
  const { errors } = await workflow.createBatch({ instances });
  for (const error of errors) if (error.code !== 10405) throw new Error(`${error.code}: ${error.message}`);
}

export default {
  async fetch(request, env, ctx) {
    // routes read bindings as context.cloudflare.env, such as context.cloudflare.env.PROCESS_WEBHOOK
    return requestHandler(request, { cloudflare: { env, ctx } });
  },
  // the consumer from the guide's "Limit concurrency per store", moved to its own file
  queue: consumeExternal,
  async scheduled(controller, env) {
    const at = new Date(controller.scheduledTime).toISOString();
    // controller.cron is the expression exactly as written in triggers.crons
    switch (controller.cron) {
      case "0 2 * * *":
        // one instance per day, so a repeated run starts nothing
        return await start(env.PRUNE_AUDIT_LOGS, [{ id: instanceId("prune-audit-logs", at.slice(0, 10)) }]);
      case "0 * * * *": {
        const { rows } = await withDb((db) => db.query<{ shop: string }>("select distinct shop from shopify_session"));
        // createBatch takes 100 instances, and a Workflow answers more than 100 new instances a second with 429
        for (let i = 0; i < rows.length; i += 100) {
          if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
          await start(env.RECONCILE_SHOP, rows.slice(i, i + 100).map(({ shop }) => ({ id: instanceId("reconcile", shop, at.slice(0, 13)), params: { shopId: shop } })));
        }
        return;
      }
      default:
        throw new Error(`no handler for the cron "${controller.cron}"`);
    }
  },
} satisfies ExportedHandler<Env, ExternalJob>;
```

### `app/entry.server.tsx`

Replaces the template's file, keeping its Shopify headers, timeout, and full render for bots:

```tsx
// in app/entry.server.tsx
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";
import { addDocumentResponseHeaders } from "./shopify.server";
// React Router rejects loader promises still pending after this many milliseconds
export const streamTimeout = 5000;

export default async function handleRequest(request: Request, responseStatusCode: number, responseHeaders: Headers, routerContext: EntryContext) {
  // the template's Shopify headers, such as the frame-ancestors policy for the admin
  addDocumentResponseHeaders(request, responseHeaders);
  const body = await renderToReadableStream(<ServerRouter context={routerContext} url={request.url} />, {
    // stop a second after React Router gives up on pending loaders, as the template does
    signal: AbortSignal.timeout(streamTimeout + 1000),
    onError: (error: unknown) => void ((responseStatusCode = 500), console.error(error)),
  });
  // bots and SPA mode get the whole page at once, like the template's onAllReady
  if (isbot(request.headers.get("user-agent") ?? "") || routerContext.isSpaMode) await body.allReady;
  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
```

### `vite.config.ts`

The template's file with the plugin, a default environment for the dev server, the `shopify app dev` variables passed to the Worker, and a build that refuses to run without an environment:

```typescript
// in vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// shopify app dev sets these in this process, and a Worker sees only its vars and .dev.vars
// SHOPIFY_API_SECRET isn't here: the Worker reads it from .dev.vars even when this sets it
const SHOPIFY_CLI_VARS = ["SHOPIFY_APP_URL", "SHOPIFY_API_KEY", "SCOPES"];

export default defineConfig(({ command }) => {
  // wrangler.jsonc keeps every binding inside an environment, so the dev server uses staging's
  if (command === "serve") process.env.CLOUDFLARE_ENV ??= "staging";
  // the template's workaround: the Shopify CLI passes the tunnel URL as HOST
  if (process.env.HOST && (!process.env.SHOPIFY_APP_URL || process.env.SHOPIFY_APP_URL === process.env.HOST)) {
    process.env.SHOPIFY_APP_URL = process.env.HOST;
    delete process.env.HOST;
  }
  const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;
  const hmr = host === "localhost" ? { protocol: "ws", host, port: 64999, clientPort: 64999 } : { protocol: "wss", host, port: parseInt(process.env.FRONTEND_PORT!) || 8002, clientPort: 443 };
  return {
    server: { allowedHosts: [host], cors: { preflightContinue: true }, port: Number(process.env.PORT || 3000), hmr, fs: { allow: ["app", "node_modules"] } },
    plugins: [
      // a build without an environment deploys a third Worker, my-app, with no bindings
      { name: "require-cloudflare-env", apply: "build", buildStart() { if (!process.env.CLOUDFLARE_ENV) this.error("set CLOUDFLARE_ENV to staging or production when you build"); } },
      cloudflare({
        viteEnvironment: { name: "ssr" },
        // dev only, so a tunnel URL never reaches a build's configuration
        config: command === "serve" ? (config) => void (config.vars = { ...config.vars, ...Object.fromEntries(SHOPIFY_CLI_VARS.filter((n) => process.env[n]).map((n) => [n, process.env[n]!])) }) : undefined,
      }),
      reactRouter(),
      tsconfigPaths(),
    ],
    build: { assetsInlineLimit: 0 }, optimizeDeps: { include: ["@shopify/app-bridge-react"] },
  } satisfies UserConfig;
});
```

### Presigned R2 uploads and downloads

An R2 binding can't sign URLs, so this signs with R2's S3 credentials and `aws4fetch`, with the same rules as [files-and-storage.md](../files-and-storage.md): the server picks the key, and the URL signs the type and size. In development, point `R2_ENDPOINT` in `.dev.vars` at a local S3-compatible server, because the local R2 binding serves no presigned URLs:

```typescript
// in app/services/files.server.ts
import { env } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg"]);
// R2's S3 API takes the region "auto"
const r2 = () => new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });

function objectUrl(key: string, expiresInSeconds: number): URL {
  const url = new URL(`${env.R2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`, `${env.R2_ENDPOINT}/`);
  // without it, aws4fetch signs for 24 hours
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  return url;
}
export async function createUpload(shopId: string, widgetId: string, file: { name: string; type: string; size: number }) {
  if (!ALLOWED.has(file.type)) throw new Response("file type not allowed", { status: 422 });
  if (file.size > MAX_BYTES) throw new Response("file too large", { status: 422 });
  const safeName = file.name.replace(/[^\w.-]+/g, "_").slice(-100);
  const key = `shops/${shopId}/widgets/${widgetId}/manual/${crypto.randomUUID()}-${safeName}`;
  const signed = await r2().sign(objectUrl(key, 15 * 60).toString(), {
    method: "PUT",
    headers: { "content-type": file.type, "content-length": String(file.size) },
    // aws4fetch leaves content-type and content-length unsigned unless allHeaders is set, and then any type and size uploads
    aws: { signQuery: true, allHeaders: true },
  });
  return { url: signed.url, key };
}
export async function downloadUrl(key: string, fileName: string) {
  // 3 hours, as long as Gadget's private file URLs last
  const url = objectUrl(key, 3 * 60 * 60);
  url.searchParams.set("response-content-disposition", `attachment; filename="${fileName.replace(/["\\\r\n]/g, "_")}"`);
  return (await r2().sign(url.toString(), { aws: { signQuery: true } })).url;
}
```

Against an S3-compatible server with region `auto`, a `PUT` with the signed type and size returned `200`, another type or size `403`, and the download URL `200` with the attachment header. The browser needs a CORS rule on the bucket, set with `npx wrangler r2 bucket cors set my-app-files --file r2-cors.json`:

```json
// in r2-cors.json
{ "rules": [{ "allowed": { "origins": ["https://app.example.com"], "methods": ["PUT"], "headers": ["content-type"] }, "maxAgeSeconds": 3600 }] }
```

## Cutover

The order in [cutover.md](../cutover.md) and the guide's [Cut over to the new platform](https://docs.gadget.dev/guides/moving-to-another-platform/cloudflare#cut-over-to-the-new-platform) holds. On Cloudflare:

- **Crons run from the deploy that adds them**, and a new one can take 15 minutes to start. Add `triggers.crons` in the "Move scheduled work" deploy. To stop them, deploy `"crons": []`.
- **Backfills run as Workflows**, one instance per store, such as `instanceId("backfill", shop)`. Each instance makes 10,000 subrequests by default, and `limits.subrequests` raises it. A backfill from your computer gets `403` once the IP allowlist is enforced.
- **The allowlist gets ASN `13335` and your countries.** Queue consumers, crons, and Workflows can run in countries placement doesn't cover, so let each kind of job run before you enforce.
- **Rollback.** `npx wrangler rollback --env production` moves the Worker back, not your migrations.

## What wasn't verified

Run locally with Wrangler 4.160.0, the Cloudflare Vite plugin 1.68.0, Postgres 18.6, and Shopify's React Router template: every example above typechecks after `wrangler types --env production --strict-vars=false`, both environments pass `wrangler deploy --dry-run`, and the app served the webhook, cron, and queue flows described above. The R2 helpers were signed against versitygw 1.0.20, an S3-compatible server, because no MinIO image could be pulled and nothing ran on a Cloudflare account.

Without an account, these come from Cloudflare's documentation and the guide's fact-check: Hyperdrive's caching and its 60-second statement limit, which local Hyperdrive skips; production error texts, which may differ from local ones; whether a failed cron run is retried; Cron propagation; R2's handling of signed `content-length` and of the CORS rule; Queue and Workflow limits; and the ASN and country Shopify sees for a Worker, consumer, cron, or Workflow.
