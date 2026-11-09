# Replacing the Gadget client in the frontend

## What is this?

The frontend talks to Gadget through the generated client (`@gadget-client/my-app`, imported from `web/api`) and the hooks in `@gadgetinc/react`. Both speak Gadget's GraphQL API, so pointing them at a new server doesn't work. The default is to rewrite every call site, and the rest of this file shows how. To find them all, search for imports of `web/api` and of `@gadgetinc/*`; the inventory script counts each hook.

The alternative is to keep the call sites and replace the packages: alias `@gadget-client/my-app` and `@gadgetinc/react` in the bundler to modules of your own that export the same names and call your new API. It saves the rewrite on an app with hundreds of call sites, and it moves the risk into the replacement, which has to return what Gadget returned. `useFindMany` returns `[{ data, fetching, error }, refetch]`. A list has `hasNextPage`, `hasPreviousPage`, `nextPage()`, and `previousPage()`. A related record comes back as an object, such as `shop: { id: "42" }`, and its bare id as `shopId`. Ids are strings, and `select` decides which fields come back. A replacement that gets one of these wrong usually shows up as a page that renders nothing, not as an error, so open every page against it before relying on it. Treat it as a way to move sooner, and still plan the rewrite.

The components themselves mostly survive. A Gadget frontend is a Vite React app in `web/`, usually with React Router or Remix routes, so the JSX, styles, and route layout move across. What changes is where each component gets its data and how it sends writes.

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

The `where` clause replaces Gadget's shop tenancy filter. `session.shop` is the `.myshopify.com` domain, which Gadget stored as `myshopifyDomain`. Gadget's `domain` field is the store's primary domain, often a custom one, so filtering on it returns nothing for those stores. `db.server` default-exports the Prisma client, and the template's own routes import it as `db`.

Each option on a read hook has a counterpart in the query:

| Gadget option | In a Prisma query |
|---|---|
| `filter` | `where` |
| `sort` | `orderBy` |
| `select` | `select` or `include`. Gadget returned only selected fields, so a loader that returns whole rows can send the browser fields the hook never exposed |
| `first` and `after` | `take` with `cursor` and `skip: 1` |
| `search` | [search.md](search.md) |
| `live: true` | [realtime.md](realtime.md) |

A loader returns JSON, so a `Date` or `Decimal` from Prisma reaches the component as a string or loses precision unless you convert it.

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

`<s-button>` only submits the form with `type="submit"`; its default type is `button`. The template's own example submits with `useFetcher` instead of `Form`, which also gives you the pending state that `useAction` returned as `fetching`.

`findUniqueOrThrow` on `myshopifyDomain` needs a unique index on that column.

Gadget's hooks returned `{ data, fetching, error }`, and an action's validation failures arrived in `error.validationErrors`. A route action has no such contract. Return the errors from the action and read them with `useActionData`, or throw and render them in the route's `ErrorBoundary`.

## The other pieces

| Gadget | Replacement |
|---|---|
| `Provider` from `@gadgetinc/react-shopify-app-bridge` | The template's `AppProvider` from `@shopify/shopify-app-react-router/react`, which takes the app's `apiKey` and loads App Bridge and Polaris |
| `useGadget()` | `isAuthenticated`, `loading`, and `canAuth` go away: a route under `app.tsx` only renders after `authenticate.admin` passed in its loader. `appBridge` becomes the global `shopify` object, or `useAppBridge()` from `@shopify/app-bridge-react` |
| `Provider` from `@gadgetinc/react` | Nothing. Loaders need no client provider |
| `useFindOne`, `useFindFirst`, `useFindBy`, `useMaybeFindOne`, `useMaybeFindFirst`, `useFindMany` | Loaders. The `Maybe` hooks returned `null` for a missing record and the others threw, which is `findUnique` against `findUniqueOrThrow` in Prisma |
| `useGet` on a singleton such as `api.currentSession` | The session your loader already has |
| `useView` and `api.view` | A SQL query in a loader ([computed-views.md](computed-views.md)) |
| `context.api`, `context.session`, `context.gadgetConfig` in React Router or Remix loaders | Your data access functions and your sign-in provider's session. These came from Gadget's server ([non-shopify-apps.md](non-shopify-apps.md)) |
| `useAction`, `useGlobalAction`, `useBulkAction`, `useActionForm` | Route actions with `Form` or `useFetcher`. `useActionForm` wrapped `react-hook-form`, which you can keep using on its own |
| `useEnqueue` and `api.enqueue` from the frontend | A route action that queues the job ([background-jobs.md](background-jobs.md)) |
| `useFetch` and `api.fetch` calls to Gadget HTTP routes | `fetch` to the new routes. Inside the embedded admin, App Bridge adds the session token to `fetch` calls to your app's domain and its subdomains |
| `useQuery` and `useMutation` with hand-written GraphQL | Loaders and route actions. There is no GraphQL API on the new app unless you build one |
| `live: true` | Supabase Realtime, Convex, or polling with `useRevalidator` ([realtime.md](realtime.md)) |
| `AutoTable`, `AutoForm`, `AutoButton`, and the `Auto*Input` components, from `@gadgetinc/react/auto/polaris`, `/auto/polaris-wc`, or `/auto/shadcn` | Pages you build by hand, with Polaris web components (`<s-page>`, `<s-section>`, `<s-text-field>`) in the template. They read your models' fields and validations from Gadget at runtime, so each one becomes an explicit table or form |
| `useTable`, `useList` | A loader with pagination in the URL's search params |
| `useUser`, `useSession`, `useAuth`, `useSignOut`, `SignedIn`, `SignedOut`, `SignedInOrRedirect`, `SignedOutOrRedirect` | Your sign-in provider's hooks and components, or a redirect in the loader ([users-and-auth.md](users-and-auth.md)) |
| File inputs that upload through Gadget | An upload to your new file storage, such as a signed upload URL |

## Values Gadget put in the page

Gadget injects these into the frontend, and none exist on the new host:

| Gadget | Replacement |
|---|---|
| `process.env.GADGET_PUBLIC_APP_SLUG`, `GADGET_PUBLIC_APP_ENV`, `GADGET_PUBLIC_SHOPIFY_APP_URL` | Your own environment variables |
| `process.env.GADGET_APP`, `GADGET_ENV`, `GADGET_APP_URL`, which Gadget also sets on the server | Your own environment variables |
| Your own variables that start with `GADGET_PUBLIC` | The new bundler's public prefix, such as `VITE_` with `import.meta.env`, or values returned from a loader |
| `window.gadgetConfig.apiKeys.shopify` | `process.env.SHOPIFY_API_KEY`, returned from the `app.tsx` loader as the template does |
| `window.gadgetConfig.environment`, `.env`, `.shopifyInstallState`, `.authentication` | Values returned from a loader |

Search `web/` for `gadgetConfig` and `GADGET_` to find them.

## Callers outside the frontend

The same client runs in places a search of `web/` misses. Each one stops working when the Gadget app is gone:

- **Theme and storefront code** that loads `https://my-app.gadget.app/api/client/web.min.js` in a script tag, or calls the app's GraphQL API directly.
- **Shopify extensions** that use `@gadgetinc/shopify-extensions` ([shopify-signatures.md](shopify-signatures.md) covers verifying their session tokens).
- **Other apps and scripts** that install `@gadget-client/my-app` and call the API with an API key.

List the API keys in the production environment's settings to see who else calls the app.

## Common pitfalls

- **Filtering on `shop.domain`.** Stores with custom domains see no records.
- **Sorting Shopify records by `createdAt`.** That's when your app stored the record, not when Shopify created it. Use `shopifyCreatedAt`.
- **Trusting a shop id sent from the browser.** Take the store from `authenticate.admin`.
- **Returning whole rows from a loader.** Loader data is sent to the browser. Select the fields the page needs, as the hook's `select` did.
- **Missing a call site.** Global actions (`api.doThing()`), namespaced models, and `api.fetch` don't match a search for `api.<model>.<action>`. Search for the imports.
- **Leaving `<s-button>` without `type="submit"`.** The form never submits.

## Related references

- [shop-tenancy.md](shop-tenancy.md): scoping the queries loaders run
- [actions-and-transactions.md](actions-and-transactions.md): the functions route actions call
- [realtime.md](realtime.md) and [search.md](search.md): replacing `live: true` and `search`
