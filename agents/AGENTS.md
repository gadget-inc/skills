# Gadget Platform Documentation Index

**Base URL**: https://docs.gadget.dev

_This document uses TypeScript examples (`.ts`/`.tsx`). If your app uses JavaScript, change file extensions to `.js`/`.jsx` and remove TypeScript-only type annotations._

> **📖 Documentation URLs**: All doc paths support `.md` extension for raw markdown retrieval.
> Example: `https://docs.gadget.dev/guides/actions/writing-actions.md`

> **💡 For best practices and code patterns**, see the **gadget-best-practices** skill. This document provides the documentation structure; that skill provides opinionated guidance and common patterns.

## What is Gadget?

Gadget is a full-stack platform for building backends with integrated frontends. Key capabilities:
- **Backend**: Models, actions, HTTP routes, background jobs
- **Database**: PostgreSQL with auto-generated GraphQL/REST APIs
- **Frontend**: React Router v7 with SSR, loaders, and action functions | auto-generated client libraries
- **Integrations**: Native Shopify, BigCommerce, OpenAI connections
- **Deployment**: Multi-environment (dev/prod) with instant deploys

> **Fully typed**: All generated client libraries, action contexts, and route handlers are fully typed — leverage the types for autocompletion and safety.

## Core Concepts

**Model** = Database table with fields | **Action** = Function that modifies data | **Record** = Row in a model
**Field** = Column in model | **API identifier** = camelCase name for programmatic access
**Environment** = Isolated deployment (development/production) | **Connection** = Integration to external API
**HTTP Route** = Custom API endpoint | **Global Action** = Action not tied to a model
**Gelly** = Gadget's query filter language | **Background Action** = Async action triggered by events

## Documentation Structure

### GUIDES (/guides/*.md)

#### Getting Started
- what-is-gadget.md | how-to-build-a-gadget-app.md | how-is-gadget-different-from-x.md | quickstarts/web-quickstart.md

#### Models (/guides/models/*.md)
- overview.md | fields.md | storing-files.md | relationships.md | namespaces.md

#### Actions (/guides/actions/*.md)
- overview.md | types-of-actions.md | whats-in-an-action.md | writing-actions.md | background-actions.md | triggers.md | namespacing-global-actions.md | actions-and-api.md

#### HTTP Routes (/guides/http-routes/*.md)
- overview.md | route-structure.md | route-configuration.md | common-use-cases.md

#### Data Access (/guides/data/*.md)
- api-access-to-data.md | computed-fields.md | computed-views.md | gelly.md | overview.md

#### Frontends (/guides/frontend/*.md)
- overview.md | building-with-remix.md | building-with-react-router.md | building-with-tailwind-css.md | forms.md | realtime-queries.md | shared-code.md | external-frontends.md | optimize-lcp.md
- autocomponents/polaris.md | autocomponents/shadcn.md

#### Authentication (/guides/access-control/*.md)
- overview.md | auth-flows.md | building-with-google-oauth.md | building-with-email-password.md | helpers.md | removing-default-auth-methods.md

#### Plugins & Connections (/guides/plugins/*.md)

**Shopify** (/plugins/shopify/*.md)
- quickstart.md | overview.md | webhooks.md | syncing-shopify-data.md | app-frontends.md | embed-previews.md | polaris.md | api-version-changelog.md
- advanced-topics/data-security.md | advanced-topics/metafields.md | advanced-topics/oauth.md | advanced-topics/billing.md | advanced-topics/shopify-app-toml.md | advanced-topics/extensions.md | advanced-topics/customer-account-ui-extensions.md

**BigCommerce** (/plugins/bigcommerce/*.md)
- overview.md | webhooks.md | working-with-bigcommerce-data.md | building-single-click-app-frontends.md | app-extensions.md | catalyst-storefronts.md | api-extensions.md

**OpenAI** (/plugins/openai/*.md)
- overview.md | building-with-openai.md | building-chatgpt-apps.md

**Other**
- plugins-overview.md | extending-gadget.md | sentry.md

#### Development Tools (/guides/development-tools/*.md)
- logger.md | ggt.md | environment-variables.md | terminal.md | typescript-support.md | unit-testing.md | framework-linter.md | rate-limits.md | runtime-environment.md | operations-dashboard.md | debugging-and-profiling.md | keyboard-shortcuts.md
- ai-assistant/features.md | ai-assistant/prompt-guide.md

#### Environments & Deployment (/guides/environments/*.md)
- overview.md | deployment.md | set-up-ci-cd-pipeline.md | custom-domains.md | development-pausing.md

#### Other Guides
- source-control.md | templates.md | account-and-billing.md | faq.md | glossary.md | what-gadget-gives-you.md

#### Tutorials (/guides/tutorials/*.md)
- ai-screenwriter.md | automated-product-tagger.md | bigcommerce-product-search-keywords.md | bigcommerce-size-charts.md | chatgpt-todo-list.md | middleware.md | shopify-ui-extension.md | shopify-theme-app-extensions.md

#### Framework Migrations (/guides/framework-version-migrations/*.md)
- v1.md | v1.3.md | v1.4.md

### API REFERENCE (/api/[app-slug]/[environment]/*.md)

**Context**: Auto-generated per-app API documentation. These pages reference YOUR specific models, actions, and configuration.

- introduction.md | model.md | actions.md | global-actions.md | global-views.md | session-model.md | gadget-record.md | sorting-and-filtering.md | schema.md | graphql.md | authentication.md | installing.md | using-with-react.md | type-safety.md | errors.md | external-api-calls.md | api-calls-within-gadget.md | internal-api.md | api-client-changelog.md

### PACKAGE REFERENCE (/reference/*.md)

**ggt CLI** (/reference/ggt.md)
- Commands: dev | pull | push | deploy | sync | add | status | open | log | whoami
- Use `ggt add` to create models, actions, routes (avoid hand-creating model folders/files)

**Gelly Query Language** (/reference/gelly.md)
- Filter operators: equals | notEquals | in | notIn | greaterThan | lessThan | startsWith | endsWith
- Logical: and | or | not
- Functions: isSet | any | every

**gadget-server** (/reference/gadget-server.md)
- Functions: save | applyParams | deleteRecord | transitionState | globalActionContext | logger | connections
- Types: ActionContext | GlobalActionContext | RouteContext | GadgetRecord

**@gadgetinc/react** (/reference/react.md)
- Hooks: useAction | useActionForm | useFindOne | useFindMany | useGet | useMaybeFindOne | useMaybeFindMany | useMutation | useLiveQuery
- Components: Provider | SignedInOrRedirect | SignedOutOrRedirect

**@gadgetinc/preact** (/reference/preact.md)
- Preact-specific client library (similar API to React)

**@gadgetinc/react/auto** (/reference/react-auto.md)
- Components: AutoForm | AutoTable | AutoButton | AutoInput | AutoTextInput | AutoNumberInput | AutoBooleanInput | AutoFileInput | AutoRelationshipInput
- Polaris variants: PolarisAutoForm | PolarisAutoTable
- Shadcn variants: ShadcnAutoForm | ShadcnAutoTable

**@gadgetinc/react-shopify-app-bridge** (/reference/react-shopify-app-bridge.md)
- Components: AppBridgeProvider | useAppBridge
- Auth: useGadgetAuth | useBillingCheck

**@gadgetinc/shopify-extensions** (/reference/shopify-extensions.md)
- Hooks: useAction | useFindOne | useFindMany | useAuth
- Extension utilities for checkout/post-purchase/customer-account UI extensions

**@gadgetinc/react-bigcommerce** (/reference/react-bigcommerce.md)
- Components: BigCommerceProvider
- Hooks: useAction | useFindOne | useFindMany

**@gadgetinc/react-chatgpt-apps** (/reference/react-chatgpt-apps.md)
- Hooks: useChatGPTAuth | useAction

## Code Patterns

### Model Action Pattern
```ts
// api/models/widget/actions/create.ts
import { save, applyParams } from "gadget-server";

export const run: ActionRun = async ({ params, record }) => {
  applyParams(params, record);
  await save(record);
};
```

### Global Action Pattern
```ts
// api/actions/processData.ts
export const run: GlobalActionRun = async ({ params, logger, connections }) => {
  logger.info({ params }, "Processing data");
  return { success: true };
};
```

### HTTP Route Pattern
```ts
// api/routes/GET-data.ts
export default async function route(request, reply) {
  const data = await api.widget.findMany();
  await reply.send({ data });
}
```

### Frontend Route Pattern
Routes live in `web/routes/` and are server-rendered. `context` provides access to `api` and `session`.
Forms that post to an `action` must include the `csrfToken` from outlet context as a hidden input.

```tsx
// web/routes/widgets.tsx
import { useOutletContext } from "react-router";
import type { Route } from "./+types/widgets";
import type { RootOutletContext } from "../root";

export const loader = async ({ context }: Route.LoaderArgs) => {
  const widgets = await context.api.widget.findMany();
  return { widgets };
};

export const action = async ({ context, request }: Route.ActionArgs) => {
  const formData = await request.formData();
  await context.api.widget.create({ name: formData.get("name") as string });
  return { success: true };
};

export default function Widgets({ loaderData }: Route.ComponentProps) {
  const { widgets } = loaderData;
  const { csrfToken } = useOutletContext<RootOutletContext>();

  return (
    <>
      <form method="post">
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input name="name" />
        <button type="submit">Create</button>
      </form>
      <ul>{widgets.map((w) => <li key={w.id}>{w.name}</li>)}</ul>
    </>
  );
}
```

## Common Scenarios

**Query with filters**: `api.widget.findMany({ filter: { title: { startsWith: "Hello" } } })`
**Soft delete**: Use `deleted` boolean field + access control
**File upload**: Field type = `file` | Access via `record.fileField.url`
**Relationships**: `belongsTo` (one) | `hasMany` (many) | `hasOne` (one)
**Auth**: Session stored in `request.session` | User in `request.user`
**Background jobs**: Action with `triggers: { api: true }` + `.enqueue()` method
**Shopify sync**: Auto-synced via webhooks | Manual via `shopifySync` connection
**Environment variables**: `process.env.GADGET_ENV` = "development" | "production"
**Multi-tenancy**: Filter by `shopId` or `userId` in access control

## File Locations

- Models: `api/models/**/{modelName}/schema.gadget.ts`
- Actions: `api/models/**/{modelName}/actions/{actionName}.ts`
- Global Actions: `api/actions/**/{actionName}.ts`
- Computed Views: `api/views/**/{viewName}.gelly`
- Routes: `api/routes/{METHOD}-{path}.ts` (e.g., `GET-users-[id].ts`)
- Access Control: `api/models/**/{modelName}/access.gelly`
- Frontend: `web/` (Vite-based, react-router v7)
- Settings: `.gadget/` (environment configs, plugin settings)

## Important Behaviors

- **Auto-validation**: Fields validate before `save()` (can customize in action)
- **Auto-timestamps**: `createdAt`/`updatedAt` managed by Gadget
- **Transactions**: Model actions `run` functions transactional by default
- **Error handling**: Throw errors to return to client | Use `logger.error()` for logging
- **Session management**: Auto-managed | Access via `session` context param
- **Shopify webhooks**: Auto-registered | Auto-trigger actions on shop events

## Retrieval Instructions

**Fetching docs**: Append `.md` to any path for raw markdown. Example:
- `https://docs.gadget.dev/guides/actions/writing-actions.md`
- `https://docs.gadget.dev/reference/gadget-server.md`

**For implementation questions**: Fetch from `/guides/*.md` for conceptual overviews and patterns
**For API usage**: Fetch from `/api-reference/*.md` or `/reference/*.md` for specific function signatures
**For Shopify**: Reference `/guides/plugins/shopify/*.md` extensively (21+ docs)
**For BigCommerce**: Reference `/guides/plugins/bigcommerce/*.md` (7 docs)
**For framework details**: Fetch `gadget-server.md` reference and action/route guides
**For client usage**: Fetch `react.md` reference and frontend guides
**For migrations**: Check framework version migration guides for breaking changes

Prefer retrieval-led reasoning. When uncertain about Gadget-specific APIs or behaviors, fetch the documentation rather than relying on general web framework knowledge.
