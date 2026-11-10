# Users and sign-in

## What is this?

This applies to apps with their own users, such as web apps that use Gadget's email and password or Google sign-in. Embedded Shopify admin apps can skip it: merchants authenticate through Shopify, and the session token comes from Shopify after the move too.

| Piece | What happens on a move |
|---|---|
| Sessions | Gadget signs and stores them itself, so every session ends. Users sign in again |
| Passwords | Gadget stores a bcrypt hash. Providers that import bcrypt keep them working |
| User ids | Keep Gadget's id. Use it as the provider's id where the provider allows, and in a column where it doesn't |
| Google sign-in | Gadget's managed credentials only redirect to Gadget. Use your own OAuth client |
| Verification and reset emails | Sent by actions on Gadget's `user` model. Most providers send their own |
| Reset and verification links already sent | They point at Gadget and stop working. Users ask for a new one |

## Export users with their password hashes

Use the Internal API export from [data-export.md](data-export.md) on the `user` model. Each password comes back as:

```json
{ "id": "42", "email": "jane@example.com", "emailVerified": true, "password": { "hash": "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy" } }
```

`$2b$10$` is bcrypt with cost 10. Gadget hashes the password exactly as the user typed it, with no extra secret and no pre-hash, so any standard bcrypt library verifies it. A user with no `password` signed in with Google only.

The export file holds every user's password hash. Keep it off shared drives and out of git, and delete it when the import is done.

## Import the hashes

Each provider takes the hash in a different field. In all of them, import one user whose password you know, sign in as that user, and only then import the rest.

### Supabase Auth

```typescript
// in scripts/import-users-supabase.ts
const { error } = await supabase.auth.admin.createUser({
  email: user.email,
  password_hash: user.password?.hash, // leave out for Google-only users
  email_confirm: user.emailVerified,
  app_metadata: { gadget_id: user.id },
});
```

Supabase user ids are UUIDs, so `"42"` can't be the id. Keep it in `app_metadata.gadget_id`, the key Gadget's Supabase guide and its policies read, and in a `gadget_user_id` column on your own users table, and point other tables at that column. Use `createUser` with a service role key, not an `insert into auth.users`: a hand-written row leaves token columns `NULL`, and sign-in then fails with a `500`.

### Firebase Auth

```typescript
// in scripts/import-users-firebase.ts
const result = await getAuth().importUsers(
  users.map((user) => ({
    uid: user.id, // Gadget's id works as the uid
    email: user.email,
    emailVerified: user.emailVerified,
    passwordHash: user.password ? Buffer.from(user.password.hash) : undefined,
  })),
  { hash: { algorithm: "BCRYPT" } }
);
for (const failure of result.errors) console.error(users[failure.index].id, failure.error.message);
```

`importUsers` takes at most 1,000 users per call. It reports bad users in `result.errors` and doesn't throw, and importing a `uid` that exists replaces that user.

### Clerk

```typescript
// in scripts/import-users-clerk.ts
await clerkClient.users.createUser({
  externalId: user.id,
  emailAddress: [user.email],
  firstName: user.firstName ?? undefined,
  lastName: user.lastName ?? undefined,
  ...(user.password
    ? { passwordDigest: user.password.hash, passwordHasher: "bcrypt" }
    : { skipPasswordRequirement: true }), // Google-only users
});
```

Clerk assigns its own id and keeps Gadget's in `externalId`. Email addresses created through the Backend API count as verified. The Backend API allows 1,000 requests per 10 seconds in production and 100 in development, so pace the loop.

### Auth0

Auth0 takes a JSON file through a bulk import job:

```json
[{ "user_id": "42", "email": "jane@example.com", "email_verified": true, "password_hash": "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy" }]
```

Use `password_hash`, which accepts bcrypt `$2a$` or `$2b$` hashes with 10 rounds. `custom_password_hash` is for other algorithms, and the two can't be set together. The user becomes `auth0|42`. A file can be 500 KB at most, which is roughly 1,000 users, so split the export.

### Better Auth or your own tables

Better Auth hashes with scrypt by default, so it rejects a bcrypt hash until you replace both password functions:

```typescript
// in lib/password.ts
import bcrypt from "bcryptjs";

export const password = {
  hash: (password: string) => bcrypt.hash(password, 10),
  verify: ({ hash, password }: { hash: string; password: string }) => bcrypt.compare(password, hash),
};
```

Pass it as `emailAndPassword: { enabled: true, password }` in `betterAuth({ ... })`. Set `hash` as well as `verify`, or new sign-ups get scrypt hashes that the bcrypt `verify` can't check.

Better Auth keeps the hash on an `account` row, not on the user:

```typescript
// in scripts/import-users-better-auth.ts
type GadgetUser = {
  id: string;
  email: string;
  emailVerified: boolean | null;
  firstName: string | null;
  lastName: string | null;
  googleProfileId: string | null;
  googleImageUrl: string | null;
  password: { hash: string } | null;
  createdAt: string | number;
  updatedAt: string | number;
};

export function betterAuthRows(user: GadgetUser) {
  const createdAt = new Date(user.createdAt);
  const updatedAt = new Date(user.updatedAt);
  const accounts = [];
  if (user.password) {
    accounts.push({ id: `credential-${user.id}`, userId: user.id, providerId: "credential", accountId: user.id, password: user.password.hash, createdAt, updatedAt });
  }
  if (user.googleProfileId) {
    accounts.push({ id: `google-${user.id}`, userId: user.id, providerId: "google", accountId: user.googleProfileId, createdAt, updatedAt });
  }
  return {
    user: {
      id: user.id, // Better Auth ids are strings, so Gadget's id stays
      email: user.email.toLowerCase(),
      emailVerified: user.emailVerified ?? false,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
      image: user.googleImageUrl,
      createdAt,
      updatedAt,
    },
    accounts,
  };
}
```

Insert `user` into the `user` table and each of `accounts` into the `account` table. Better Auth lowercases the email at sign-in, so store it lowercased. Better Auth also refuses a password longer than 128 characters at sign-in, so raise `emailAndPassword.maxPasswordLength` if your users could have longer ones.

With your own tables, store the hash in a column and call `bcrypt.compare(password, hash)` at sign-in.

### ❌ Re-hashing the hash

```typescript
await auth.createUser({ email, password: user.password.hash }); // hashes the hash: nobody can sign in
```

Pass the hash in the provider's hash field, never as the password.

If your provider can't import bcrypt, send every user a password reset.

## Google sign-in

If the app used Gadget's managed Google credentials, create an OAuth client in Google Cloud and add the new app's redirect URL. If it already used your own client, add the new redirect URL to it and keep the old one until the Gadget app is off.

A user who signed in with Google has a `googleProfileId`, which is Google's account id (the `sub` claim). How the first Google sign-in after the move finds the imported user depends on the provider:

| Provider | How the imported user is matched |
|---|---|
| Supabase Auth | By verified email. Import with `email_confirm: true` |
| Clerk | By verified email. Create Google-only users with `skipPasswordRequirement: true` |
| Firebase Auth | By provider data. Add `providerData: [{ providerId: "google.com", uid: user.googleProfileId, email: user.email }]` to the imported user |
| Better Auth | By the `google` account row that `betterAuthRows` writes |
| Auth0 | Not checked here. Test it with one Google-only user |

Test this with one Google-only user before the move. A miss creates a second user with a new id and none of the first user's records.

## User fields

Gadget's default `user` model has these fields:

| Field | What to do |
|---|---|
| `email`, `firstName`, `lastName` | Copy to the provider's user or your own table |
| `emailVerified` | Carry it across, or every user gets a verification email on the new platform |
| `password` | Import the hash as above |
| `googleProfileId`, `googleImageUrl` | Keep for Google sign-in matching and avatars |
| `profilePicture` | A file. Download it during the export, because its URL expires ([data-export.md](data-export.md)) |
| `lastSignedIn` | Copy if you report on it |
| `roles` | Role names, such as `["signed-in"]`. Keep them in a `text[]` column if your code checks them |
| `emailVerificationToken`, `emailVerificationTokenExpiration`, `resetPasswordToken`, `resetPasswordTokenExpiration` | Leave behind. They only work with Gadget's verify and reset actions |

Fields you added to `user` move like any other model's fields ([schema-mapping.md](schema-mapping.md)).

## Sessions

Gadget keeps each session as a record in the `session` model and identifies it with a token only Gadget can check. None of that moves, so every user signs in once more after the cutover. If you added fields to `session`, such as a cart for visitors who aren't signed in, that data is lost at the move unless you export the `session` model and attach the data to something the new app can find again, such as the user.

Backend code that read `session.get("user")` reads the signed-in user from the new provider's session instead.

## Common pitfalls

- **Passing the hash as a password.** Every user is locked out.
- **Replacing only `verify` in Better Auth.** Imported users can sign in and new users can't.
- **Inserting into `auth.users` by hand.** Sign-in fails with a `500`. Use `auth.admin.createUser`.
- **Dropping `emailVerified`.** Users have to verify again.
- **Replacing ids with the provider's.** Records that pointed at the user break. Keep a `gadget_user_id` column.
- **Skipping the Google-only test.** A user who doesn't match gets a second, empty account.
- **Expecting sessions to carry over.** They can't. Tell users they'll sign in once more.
- **Leaving the export file around.** It holds every password hash.

## Related references

- [data-export.md](data-export.md): the export script
- [shop-tenancy.md](shop-tenancy.md): other roles, which become checks in your routes
- [frontend.md](frontend.md): replacing `useUser`, `useSession`, and `SignedIn`
- [non-shopify-apps.md](non-shopify-apps.md): row-level security keyed on users and teams instead of stores
