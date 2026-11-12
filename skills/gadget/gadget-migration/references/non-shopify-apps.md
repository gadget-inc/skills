# Moving an app that is not a Shopify app

## What is this?

Many Gadget apps have no Shopify connection: web apps with their own users, internal tools, API backends for mobile apps, and BigCommerce apps. For these, skip the Shopify references. The work that replaces them is smaller, and different:

| Shopify app | App without Shopify |
|---|---|
| Tenant is the store, taken from Shopify's session token | Tenant is the user, team, or organization, taken from your own session |
| Merchants never sign in again | Every session ends at the move, and passwords carry over only if you import the hashes |
| Callers are Shopify and your embedded frontend | Callers can be anything: browsers, mobile apps, other servers ([external-api-clients.md](external-api-clients.md)) |
| Shopify's template gives you a starting app | You choose the framework and the sign-in provider |

BigCommerce apps have their own file: [bigcommerce.md](bigcommerce.md).

## Order of work

1. **Inventory**, as for any app. Look at the roles, the Gelly filters, and the API keys in the production environment's settings.
2. **Schema and data.** [schema-mapping.md](schema-mapping.md) and [data-export.md](data-export.md) apply unchanged. Export every model: with no Shopify to backfill from, the export is the only copy.
3. **Users and sign-in.** [users-and-auth.md](users-and-auth.md). Do this before the frontend, because every permission check depends on it.
4. **Permissions.** This file.
5. **Actions, jobs, and schedules.** [actions-and-transactions.md](actions-and-transactions.md) and [background-jobs.md](background-jobs.md), unchanged.
6. **Frontend.** [frontend.md](frontend.md) for the hooks. The loaders authenticate with your sign-in provider in place of `authenticate.admin`.
7. **Files, search, live queries, and views**, if the inventory lists them: [files-and-storage.md](files-and-storage.md), [search.md](search.md), [realtime.md](realtime.md), [computed-views.md](computed-views.md).
8. **Cutover.** The last section of this file.

## Where the app runs

Gadget web apps are a Vite frontend in `web/` and a Fastify-style backend in `api/`. Two shapes cover most moves:

- **One Node server.** React Router in framework mode, or Next.js, with loaders and route actions calling your ported functions directly. Fewest moving parts. Hosts: Render, Fly.io, Railway, Cloud Run, or Vercel.
- **A backend platform plus a static frontend.** Supabase for Postgres, sign-in, storage, and realtime, with the frontend calling it directly under row-level security, and a small server or edge functions for the ported actions. Less server code, but your permission rules must be complete in the database, because the browser talks to it.

If the Gadget frontend already uses React Router or Remix in framework mode, its loaders call `context.api`, read `context.session`, and return `context.gadgetConfig`. Those three come from Gadget's server. Replace `context.api` calls with your data access functions, and `context.session` with your sign-in provider's session lookup.

## Permissions: roles and filters become policies

Gadget checked two things on every API call: whether the caller's role could run the action or read the model at all, and which records a Gelly filter let that role see. A typical filter for the `signed-in` role:

```gelly
// in accessControl/filters/post/signed-in-read.gelly
filter ($session: Session) on Post [
  where userId == $session.userId
]
```

Without it, a list page runs `select * from post` and shows every user's posts to whoever is signed in. The filter becomes a row-level security policy, with the user set at the start of each transaction:

```sql
-- in db/migrations/post_owner_policy.sql
alter table post enable row level security;
alter table post force row level security;

create policy post_owner on post
  using (user_id = nullif(current_setting('app.user_id', true), '')::bigint);
```

```sql
-- in db/queries/set_current_user.sql
select set_config('app.user_id', $1, true);
```

The third argument, `true`, ends the setting with the transaction, so a pooled connection never carries one user's id into another user's request. `current_setting('app.user_id', true)` returns null when nothing set it, the comparison is then null, and the query returns no rows. That matches Gadget, where a filter that reads `$session.userId` matches nothing for a caller with no user.

A policy with only `using` also applies to writes. An insert or update that would produce a row the user could not see is rejected, so a signed-in user can't create a post owned by someone else.

Filters that go through a relationship become a subquery:

```gelly
filter ($session: Session) on Comment [
  where post.userId == $session.userId
]
```

```sql
-- in db/migrations/comment_owner_policy.sql
alter table comment enable row level security;
alter table comment force row level security;

create policy comment_owner on comment
  using (exists (
    select 1 from post
    where post.id = comment.post_id
      and post.user_id = nullif(current_setting('app.user_id', true), '')::bigint
  ));
```

Team or organization tenancy is the same pattern with `team_id` and an `app.team_id` setting. Read the team from the user's row on the server after sign-in. Never accept it from the request.

[shop-tenancy.md](shop-tenancy.md) covers the rest of the setup, and all of it applies: the app must connect as a role that owns no tables and can't bypass row-level security, and every query must run in a transaction that set the user.

### The half that policies don't cover

Row-level security answers "which rows". Gadget roles also answered "may this caller run this action at all". Each grant in `accessControl/permissions.gadget.ts` becomes a check at the top of the route or function that replaced the action:

```typescript
// in app/services/permissions.server.ts
export function requireRole(user: { roles: string[] } | null, role: string): void {
  if (!user) throw new Response(null, { status: 401 });
  if (!user.roles.includes(role)) throw new Response(null, { status: 403 });
}
```

Go through the permissions file role by role, including `unauthenticated`. Every action that role could run needs a route that works without a session. Every action it could not run needs a check, because a new route is open to anyone until you close it.

## Cutover without Shopify

No platform switches traffic for you, so the cutover is a DNS change or a release:

1. **Stop writes in Gadget.** Ahead of time, deploy a check on an environment variable in your routes and in the actions your frontends call. Then set the variable, and turn off Gadget's scheduled actions in the same step. New frontends are not enough, because open pages and older versions of a mobile app keep calling Gadget. Removing write grants from the roles is not enough either: scheduled actions and code that calls `api` with admin access keep writing.
2. **Let Gadget's queue drain.** Background actions queued before the stop still write, so wait for the Queues dashboard to empty before the export ([background-jobs.md](background-jobs.md#moving-jobs-at-cutover)).
3. **Export what changed and load it.** Run the catch-up export filtered on `updatedAt` since the first export, upsert it, and move the id sequences ([data-export.md](data-export.md#catch-up-on-records-that-change-during-the-export), [schema-mapping.md](schema-mapping.md#move-sequences-after-loading)). Import users now too ([users-and-auth.md](users-and-auth.md#import-the-hashes)). Stopping writes and this export are both required: an export while Gadget still writes misses records changed after their page was read, and a stop without this export loses everything changed since the first one.
4. **Switch traffic and turn on the new cron jobs.** On a custom domain, change the DNS record to the new host. Lower the record's TTL a day ahead so the change takes minutes, not hours. On a `gadget.app` domain there is nothing to repoint: every caller and every link has to change to the new URL ([external-api-clients.md](external-api-clients.md)).
5. **Expect every user to sign in again**, and tell them beforehand.
6. **Keep the Gadget app** until record counts match and outside callers have stopped arriving in its logs.

An export filtered on `updatedAt` does not see deletes. If records can be deleted during the gap, compare ids between the two databases after the final load ([data-export.md](data-export.md#catch-up-on-records-that-change-during-the-export)).

## Common pitfalls

- **Porting only the frontend's checks.** Hidden buttons were never the permission system. The roles were.
- **Leaving new routes open.** Gadget denied by default. A new route allows by default.
- **Skipping models in the export.** There is no upstream to backfill from.
- **Forgetting the `unauthenticated` role.** Public pages and sign-up used it. So did any webhook route another service calls.
- **Assuming the app's URL can move.** A `gadget.app` domain stays with Gadget.

## Related references

- [users-and-auth.md](users-and-auth.md): sessions, password hashes, and Google sign-in
- [shop-tenancy.md](shop-tenancy.md): the database role and transaction setup row-level security needs
- [external-api-clients.md](external-api-clients.md): callers outside the app
- [environments.md](environments.md): development setup and deploys on the new platform
