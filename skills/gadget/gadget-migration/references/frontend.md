# Replacing the Gadget client in the frontend

## What is this?

The frontend talks to Gadget through the generated client (`@gadget-client/my-app`, imported from `web/api`) and the hooks in `@gadgetinc/react`. Both speak Gadget's GraphQL API, so pointing them at a new server doesn't work. Every call site is rewritten. To find them all, search for imports of `web/api` and of `@gadgetinc/*`; the inventory script counts each hook.

## Reads: hooks become loaders

```tsx
// in web/routes/index.tsx (Gadget)
import { useFindMany } from "@gadgetinc/react";
import { api } from "../api";

export default function Index() {
  const [{ data, fetching }] = useFindMany(api.shopifyOrder, { first: 50, sort: { shopifyCreatedAt: "Descending" } });
  // renders data
}
```

```tsx
// in app/routes/app._index.tsx (Shopify's React Router template)
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const orders = await prisma.shopifyOrder.findMany({
    where: { shop: { myshopifyDomain: session.shop } },
    orderBy: { shopifyCreatedAt: "desc" },
    take: 50,
  });
  return { orders };
};

export default function Index() {
  const { orders } = useLoaderData<typeof loader>();
  // renders orders
}
```

The `where` clause replaces Gadget's shop tenancy filter. `session.shop` is the `.myshopify.com` domain, which Gadget stored as `myshopifyDomain`. Gadget's `domain` field is the store's primary domain, often a custom one, so filtering on it returns nothing for those stores.

### ❌ Filtering on the wrong store field

```typescript
where: { shop: { domain: session.shop } } // "example.com" never equals "example.myshopify.com"
```

## Writes: actions become route actions

`useAction(api.widget.create)` and `useGlobalAction(api.doThing)` become forms that submit to a route action, or `fetch` calls with the session token:

```tsx
// in app/routes/app.widgets.new.tsx
import type { ActionFunctionArgs } from "react-router";
import { Form } from "react-router";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const shop = await prisma.shopifyShop.findUniqueOrThrow({ where: { myshopifyDomain: session.shop } });
  await createWidget(shop.id, { name: String(form.get("name")) }); // the ported action function
  return { ok: true };
};

export default function NewWidget() {
  return (
    <Form method="post">
      <s-text-field name="name" label="Name"></s-text-field>
      <s-button type="submit">Save</s-button>
    </Form>
  );
}
```

## The other pieces

| Gadget | Replacement |
|---|---|
| `Provider` and `useGadget` from `@gadgetinc/react-shopify-app-bridge` | The template's `AppProvider`, and App Bridge's own API |
| `useFindOne`, `useFindFirst`, `useFindBy`, `useMaybeFindOne` | Loaders |
| `useAction`, `useGlobalAction`, `useBulkAction`, `useActionForm` | Route actions with `Form` or `useFetcher` |
| `useFetch` calls to Gadget HTTP routes | `fetch` to the new routes. Inside the embedded admin, App Bridge adds the session token to `fetch` calls to your app's domain |
| `live: true` | Supabase Realtime, Convex, or polling with `useRevalidator` |
| `AutoTable`, `AutoForm` | Pages built with Polaris web components (`<s-page>`, `<s-section>`, `<s-text-field>`), which the template uses |
| `useUser`, `useSession`, `SignedIn`, `SignedOut` | Your sign-in provider's hooks ([users-and-auth.md](users-and-auth.md)) |
| `api.enqueue` from the frontend | A route action that queues the job |
| `GADGET_PUBLIC_APP_SLUG`, `GADGET_PUBLIC_APP_ENV`, `GADGET_PUBLIC_SHOPIFY_APP_URL` | Your own environment variables |

## Common pitfalls

- **Filtering on `shop.domain`.** Stores with custom domains see no records.
- **Sorting Shopify records by `createdAt`.** That's when your app stored the record, not when Shopify created it. Use `shopifyCreatedAt`.
- **Trusting a shop id sent from the browser.** Take the store from `authenticate.admin`.
- **Missing a call site.** Global actions (`api.doThing()`), namespaced models, and `api.fetch` don't match a search for `api.<model>.<action>`. Search for the imports.

## Related references

- [shop-tenancy.md](shop-tenancy.md): scoping the queries loaders run
- [actions-and-transactions.md](actions-and-transactions.md): the functions route actions call
