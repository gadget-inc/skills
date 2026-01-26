# Frontend Components

## Autocomponents

Gadget provides autocomponents for rapid UI development.

### AutoTable

```tsx
import { AutoTable } from "@gadgetinc/react/auto/polaris";
import { api } from "../api";

function Products() {
  return <AutoTable model={api.product} />;
}
```

Features: sorting, filtering, pagination, actions.

### AutoForm

```tsx
import { AutoForm, AutoInput, AutoSubmit } from "@gadgetinc/react/auto/polaris";

function CreateProduct() {
  return (
    <AutoForm action={api.product.create}>
      <AutoInput field="title" />
      <AutoInput field="price" />
      <AutoSubmit />
    </AutoForm>
  );
}
```

Features: validation, error handling, loading states.

## Polaris vs Shadcn

Gadget supports two autocomponent libraries:

**Polaris** - For Shopify apps:
```tsx
import { AutoTable } from "@gadgetinc/react/auto/polaris";
```

**Shadcn** - For general apps:
```tsx
import { AutoTable } from "@gadgetinc/react/auto";
```

## Session & Auth

```tsx
import { useSession } from "@gadgetinc/react";

function Profile() {
  const session = useSession();

  if (!session) return <div>Not logged in</div>;

  return <div>Hello, {session.user.email}</div>;
}
```

## Best Practices

- ✅ Use autocomponents for rapid development
- ✅ Use Polaris for Shopify apps
- ✅ Check session for authenticated routes
- ✅ Handle loading states
