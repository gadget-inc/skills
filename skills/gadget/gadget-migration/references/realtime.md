# Replacing live queries

## What is this?

A Gadget read with `live: true` keeps a WebSocket open and re-renders when the records on screen change:

```tsx
const [{ data }] = useFindMany(api.widget, { live: true, first: 50, sort: { createdAt: "Descending" } });
```

After the move, the same component shows the page as it was when it loaded, and nothing tells the user it is out of date. The inventory script counts `live: true` in the frontend. Also search for `live: true` in scripts and outside callers, where the client returns an async iterator instead of a hook result.

## What Gadget's live queries did

| Behavior | What it means for the replacement |
|---|---|
| Re-ran the query when a record on the current page changed, was added, or was removed | You need a signal that a table changed, then a refetch |
| Pushed at most one update every 500 ms, and merged changes in between | Clients saw the latest state, not every intermediate one. A debounced refetch is equivalent |
| Watched related records selected through `select` | The signal has to cover every table the page reads |
| Applied the caller's permissions and filters | The refetch must go through the same store-scoped query as the first load |
| Did not refresh when only a computed field changed | No behavior to keep |
| Capped at 250 records per page | Same as any other read |

## Pick the smallest thing that works

| Option | Use when | Cost |
|---|---|---|
| Polling | An admin page where a few seconds of delay is fine | One query per open tab per interval |
| Postgres `listen`/`notify` with server-sent events | You run a long-lived Node server and want updates within a second | One trigger per table, one dedicated database connection per server |
| Supabase Realtime, Convex, or a hosted pub/sub service | You are already on that platform, or you run on serverless functions that can't hold connections open | Their SDK and their permission model |

Most `live: true` call sites in admin apps are progress indicators and dashboards. Polling replaces those in three lines, so start there and move a page to push only when polling is too slow or too expensive.

## ✅ Polling

```tsx
// in app/routes/app.widgets.tsx
import { useEffect } from "react";
import { useRevalidator } from "react-router";

export function useLiveLoaderData(intervalMs = 5000) {
  const revalidator = useRevalidator();
  useEffect(() => {
    const tick = () => {
      // skip hidden tabs, and skip a tick while the last one is still loading
      if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate();
    };
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [revalidator, intervalMs]);
}
```

`revalidate` re-runs the route's loader, so the data goes through the same authenticated, store-scoped query as the first load. Without the visibility check, 200 merchants with a forgotten tab each cost 40 queries a second at a 5 second interval.

## ✅ Push with `listen`/`notify`

A trigger tells the database to announce each change. It sends ids only, never row data, so the browser still fetches through your permission checks:

```sql
-- in db/migrations/notify_changes.sql
create function notify_record_change() returns trigger language plpgsql as $$
declare
  changed record;
begin
  if tg_op = 'DELETE' then changed := old; else changed := new; end if;
  perform pg_notify(
    'record_changes',
    json_build_object('table', tg_table_name, 'op', lower(tg_op), 'id', changed.id, 'shop_id', changed.shop_id)::text
  );
  return null;
end;
$$;

create trigger widget_notify_change
  after insert or update or delete on widget
  for each row execute function notify_record_change();
```

Postgres delivers a notification when the transaction commits and drops it when the transaction rolls back, so a listener never hears about a write that did not happen.

One server process holds one listening connection and fans changes out to the browsers connected to it:

```typescript
// in app/services/changes.server.ts
import { EventEmitter } from "node:events";
import pg from "pg";

export type RecordChange = { table: string; op: "insert" | "update" | "delete"; id: number; shop_id: number };

export const changes = new EventEmitter();

// Call once at server start. Use a direct connection, not a transaction-mode pooler:
// a pooler hands the connection to another client and the LISTEN goes with it.
export async function listenForChanges(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  client.on("notification", (message) => {
    if (message.channel !== "record_changes" || !message.payload) return;
    const change = JSON.parse(message.payload) as RecordChange;
    changes.emit(`shop:${change.shop_id}`, change);
  });
  await client.query("listen record_changes");
  return client;
}
```

A route streams the current store's changes as server-sent events:

```typescript
// in app/routes/app.changes.tsx
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { changes, type RecordChange } from "../services/changes.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shopifyShop.findUniqueOrThrow({ where: { myshopifyDomain: session.shop } });
  const channel = `shop:${shop.id}`; // the store comes from the session, never from the query string

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (change: RecordChange) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ table: change.table })}\n\n`));
      const keepAlive = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 25_000);
      changes.on(channel, send);
      request.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        changes.off(channel, send);
        controller.close();
      });
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
};
```

In the browser, open an `EventSource` on that route and call `revalidator.revalidate()` when a message names a table the page shows, at most once every 500 ms. `EventSource` reconnects on its own. Revalidate once on every reconnect, because changes made while the connection was down are not replayed.

### ❌ Sending row data in the notification

```sql
perform pg_notify('record_changes', row_to_json(new)::text); -- every listener sees every store's rows
```

A notification goes to every listener on the channel, and its payload is limited to 8,000 bytes, so one large row raises an error inside the trigger and fails the write that fired it. Send ids and fetch.

## Common pitfalls

- **Listening through a transaction-mode pooler.** Notifications never arrive. Supabase's pooler on port 6543, PgBouncer in transaction mode, and Neon's pooled connection string all behave this way. Use the direct connection for the listener only.
- **More than one server instance.** Each instance needs its own listening connection. The trigger reaches all of them, so nothing else changes.
- **Serverless hosts.** A function that lives for one request can't hold a `listen` connection or an event stream. Use polling or a hosted realtime service there.
- **Bulk writes.** A backfill that touches 2 million rows fires 2 million notifications. Disable the trigger for the backfill, or use a statement-level trigger for that table.
- **Trusting a store id from the client.** Take the channel from the session, the same as every other query.

## Related references

- [frontend.md](frontend.md): the hooks that carried `live: true`
- [shop-tenancy.md](shop-tenancy.md): the scoping the refetch goes through
