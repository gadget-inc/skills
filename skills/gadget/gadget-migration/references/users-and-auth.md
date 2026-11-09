# Users and sign-in

## What is this?

This applies to apps with their own users, such as web apps that use Gadget's email and password or Google sign-in. Embedded Shopify admin apps can skip it: merchants authenticate through Shopify, and the session token comes from Shopify after the move too.

| Piece | What happens on a move |
|---|---|
| Sessions | Gadget signs and stores them itself, so every session ends. Users sign in again |
| Passwords | Gadget stores a bcrypt hash. Providers that import bcrypt keep them working |
| User ids | Keep Gadget's id in a column if other records refer to it |
| Google sign-in | Gadget's managed credentials only redirect to Gadget. Use your own OAuth client |
| Verification and reset emails | Sent by actions on Gadget's `user` model. Most providers send their own |

## Export users with their password hashes

Use the Internal API export from [data-export.md](data-export.md) on the `user` model. Each password comes back as:

```json
{ "id": "42", "email": "jane@example.com", "password": { "hash": "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy" } }
```

`$2b$10$` is bcrypt with cost 10, which these providers import:

- **Supabase Auth:** insert into `auth.users` with the hash in `encrypted_password`. Supabase's migration guide from Auth0 shows the columns. Supabase user ids are UUIDs, so keep Gadget's id in a separate column.
- **Firebase Auth:** `importUsers` with `hash: { algorithm: "BCRYPT" }`.
- **Clerk:** create users with `password_digest` and `password_hasher: "bcrypt"`.
- **Auth0:** a bulk import with `custom_password_hash.algorithm: "bcrypt"`.
- **Better Auth or your own table:** store the hash and verify with any bcrypt library, such as `bcrypt.compare(password, hash)`.

A user with no `password` signed in with Google only. If your provider can't import bcrypt, send every user a password reset.

### ❌ Re-hashing the hash

```typescript
await auth.createUser({ email, password: user.password.hash }); // hashes the hash: nobody can sign in
```

Pass the hash in the provider's hash field, never as the password.

## User fields

Gadget's default `user` model has `email`, `emailVerified`, `password`, `googleProfileId`, `googleImageUrl`, `firstName`, `lastName`, `profilePicture`, `lastSignedIn`, and `roles`. Carry `emailVerified` across, or every user gets a verification email on the new platform. `roles` comes back as role names, such as `["signed-in"]`; keep them in a `text[]` column if your code checks them.

## Google sign-in

If the app used Gadget's managed Google credentials, create an OAuth client in Google Cloud and add the new app's redirect URL. If it already used your own client, add the new redirect URL to it. Users who signed in with Google match on `googleProfileId` or email.

## Common pitfalls

- **Passing the hash as a password.** Every user is locked out.
- **Dropping `emailVerified`.** Users have to verify again.
- **Replacing ids with the provider's.** Records that pointed at the user break. Keep a `gadget_user_id` column.
- **Expecting sessions to carry over.** They can't. Tell users they'll sign in once more.

## Related references

- [data-export.md](data-export.md): the export script
- [shop-tenancy.md](shop-tenancy.md): other roles, which become checks in your routes
