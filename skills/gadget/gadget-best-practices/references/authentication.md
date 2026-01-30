# Authentication

**📖 Full docs:** [docs.gadget.dev/guides/plugins/authentication](https://docs.gadget.dev/guides/plugins/authentication.md)

## Built-In Auth

Gadget provides built-in authentication with:
- Email/password login
- Google OAuth
- Session management
- User model with roles

## User Model

The `user` model includes:
- `email` - User's email
- `emailVerified` - Email verification status
- `password` - Hashed password (never exposed)
- `googleProfileId` - Google OAuth ID
- `roleList` - User's roles

**⚠️ Never modify core auth fields** - they power the auth system.

## Sign Up

```javascript
// api/models/user/actions/signUp.js (built-in)
// Users can create accounts via:
await api.user.signUp({
  email: "user@example.com",
  password: "secure-password"
});
```

## Sign In

```javascript
await api.user.signIn({
  email: "user@example.com",
  password: "password"
});
```

## Sessions

Sessions track authenticated users:

**In actions:**
```javascript
export const run = async ({ api, session }) => {
  if (!session?.user) {
    throw new Error("Not authenticated");
  }

  const currentUser = session.user;
  // Use currentUser...
};
```

**In frontend:**
```tsx
import { useSession } from "@gadgetinc/react";

function Profile() {
  const session = useSession();

  if (!session) return <div>Not logged in</div>;

  return <div>Hello, {session.user.email}</div>;
}
```

## Protected Routes

**Frontend:**
```tsx
export const SomePage = () => (
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Layout />}>
        {/* This route will be accessible only if the user is signed out */}
        <Route
          index
          element={
            <SignedOutOrRedirect>
              <Home />
            </SignedOutOrRedirect>
          }
        />
        {/* This route will be accessible only if the user is signed in */}
        <Route
          path="my-profile"
          element={
            <SignedInOrRedirect>
              <MyProfile />
            </SignedInOrRedirect>
          }
        />
      </Route>
    </Routes>
  </BrowserRouter>
);
```

**Backend (routes):**
```typescript
import { preValidation, RouteHandler } from "gadget-server";

const route: RouteHandler = async ({ reply }) => {
  await reply.send("this is a protected route!");
};

route.options = {
  preValidation,
};

export default route;
```

## Shopify Auth

For Shopify apps, auth is automatic:
- Merchants authenticate via OAuth
- Session includes shop context
- `shopify-app-users` role assigned

```javascript
const shopId = connections.shopify.currentShopId;
```

## BigCommerce Auth

Similar to Shopify:
- Stores authenticate via OAuth
- Session includes store context
- `bigcommerce-app-users` role assigned

## Best Practices

- ✅ Use built-in auth system
- ✅ Check session in protected routes
- ✅ Use roles for permissions
- ✅ Never expose passwords
- ❌ Don't modify core user fields
- ❌ Don't roll your own auth
- ❌ Don't store passwords in plain text

See [access-control.md](access-control.md) for permissions.

**📖 More info:**
- [Authentication overview](https://docs.gadget.dev/guides/plugins/authentication.md)
- [Email/password auth](https://docs.gadget.dev/guides/plugins/authentication/email-pass.md)
- [Google OAuth](https://docs.gadget.dev/guides/plugins/authentication/google-oauth.md)
- [Auth workflows](https://docs.gadget.dev/guides/plugins/authentication/workflows.md)
