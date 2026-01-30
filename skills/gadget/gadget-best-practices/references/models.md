# Data Models

**📖 Full docs:** [docs.gadget.dev/guides/models](https://docs.gadget.dev/guides/models.md)

## What Are Models?

In Gadget, a **model** represents a database table. Each table row is a **record**.

- Models define the schema for storing data
- Each model auto-generates a GraphQL API for CRUD operations
- Models support relationships, validations, and computed fields
- Created with `ggt add model <name>` 

**IMPORTANT:** Use the [ggt CLI](ggt-cli.md) to add models

## Naming Conventions

### Use Singular Names

Models should **always** be singular, never plural:

```
✅ post
✅ blogPost
✅ user

❌ posts
❌ blogPosts
❌ users
```

**Why?** The API will pluralize automatically for collections:
- `api.post.findMany()` - reads naturally
- `api.posts.findMany()` - awkward double plural

### Avoid Superfluous Suffixes

Don't add unnecessary suffixes like "model", "table", or "system":

```
✅ post
✅ product
✅ order

❌ postModel
❌ productTable
❌ orderSystem
```

## Auto-Generated Fields

Every model automatically gets these fields:

- `id` - Unique identifier (UUID)
- `createdAt` - Creation timestamp
- `updatedAt` - Last modification timestamp

**Never manually create these fields** in your schema - Gadget adds them automatically and they cannot be removed.

## Model Responsibility

### What Models Should Do

Models are responsible for **data storage only**:

✅ Store persistent data
✅ Define structure and relationships
✅ Capture data needed for business logic
✅ Support retrieval and queries

### What Models Should NOT Do

Models are NOT responsible for:

❌ Implementing business logic (use **actions** for this)
❌ Storing transient or computed data
❌ Describing UI or frontend functionality (only the data that supports it)

**Example:**
If a requirement says "users can publish posts and see analytics", the model needs:
- ✅ `post` model with `publishedAt` field (for publish action)
- ✅ `post` model with `viewCount` field (for analytics display)
- ❌ Does NOT need a separate `analytics` or `publishAction` model

## When to Create Models

### DO Create Models For:

✅ **Persistent entities** - Users, products, orders, posts
✅ **Structured data** - Data with known schema
✅ **Independently manageable records** - Records that can be created, updated, deleted separately
✅ **Relationships** - When data relates to other data (instead of JSON)

### DON'T Create Models For:

❌ **Audit logs** - Gadget handles this automatically
❌ **Reporting data** - Use computed views instead
❌ **Transient data** - Data that doesn't need to persist
❌ **Computed values** - Use computed fields or views instead
❌ **Boolean alternatives** - Don't create a model when an enum or boolean field would work

**Examples:**

```typescript
// ❌ Over-engineered - separate model just to store "retail" or "wholesale"
// api/models/locationType/schema.gadget.ts
export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Abc123DefGhi",
  fields: {
    locations: {
      type: "hasMany",
      children: { model: "location", belongsToField: "locationType" },
      storageKey: "Jkl456MnoPqr",
    },
  },
};

// ✅ Simple and pragmatic - use enum field instead
// api/models/location/schema.gadget.ts
import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Stu789VwxYza",
  fields: {
    type: {
      type: "enum",
      options: ["retail", "wholesale"],
      storageKey: "Bcd012EfgHij",
    },
  },
};
```

```typescript
// ❌ Over-engineered - model just for analytics
// api/models/userActivity/schema.gadget.ts
export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Klm345NopQrs",
  fields: {
    action: { type: "string", storageKey: "Tuv678WxyZab" },
    user: {
      type: "belongsTo",
      parent: { model: "user" },
      storageKey: "Cde901FghIjk",
    },
  },
};

// ✅ Use Gadget's built-in audit logs and analytics
// No model needed!
```

## Data Normalization

### Prefer Normalized Data

Avoid duplication - normalize relationships:

```typescript
// ❌ Denormalized - api/models/order/schema.gadget.ts
import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Lmn456OpqRst",
  fields: {
    customerName: { type: "string", storageKey: "Uvw789XyzAbc" },
    customerEmail: { type: "string", storageKey: "Def012GhiJkl" },
    customerPhone: { type: "string", storageKey: "Mno345PqrStu" },
  },
};

// ✅ Normalized - api/models/order/schema.gadget.ts
import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Vwx678YzaBC",
  fields: {
    customer: {
      type: "belongsTo",
      parent: { model: "customer" },
      storageKey: "Def901GhiJkl",
    },
  },
};

// api/models/customer/schema.gadget.ts
import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Mno234PqrStu",
  fields: {
    name: { type: "string", storageKey: "Vwx567YzaBcd" },
    email: { type: "email", storageKey: "Efg890HijKlm" },
    phone: { type: "string", storageKey: "Nop123QrsTuv" },
  },
};
```

### But Be Pragmatic

Sometimes denormalization is OK for performance:

```typescript
// ✅ Acceptable for fast queries - api/models/order/schema.gadget.ts
import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Wxy456ZabCde",
  fields: {
    customer: {
      type: "belongsTo",
      parent: { model: "customer" },
      storageKey: "Fgh789IjkLmn",
    },
    customerEmail: {
      type: "string",
      storageKey: "Opq012RstUvw",
      comment: "Cached for quick access",
    },
  },
};
```

## JSON vs Models

### When to Use JSON Fields

Use `json` field type for:

✅ Unstructured data (arbitrary key-value pairs)
✅ Data with unknown schema at design time
✅ External API responses you don't control

### When to Use Related Models Instead

Use a separate model when:

✅ You know the schema ahead of time
✅ You need type checking and validation
✅ You want to query or filter by nested fields
✅ You need relationships or independent management

## Boolean vs Enum vs Related Model

### Use Boolean For:

✅ True/false states
✅ Binary choices

```javascript
field isPublished: Boolean
field emailVerified: Boolean
```

### Use Enum For:

✅ 2-5 fixed options
✅ Named states

```javascript
field status: Enum { draft, published, archived }
field locationType: Enum { retail, wholesale }
```

### Use Related Model For:

✅ Many options (6+)
✅ Options that change over time
✅ Options with additional data

```typescript
// ❌ Don't use a model for simple states
// api/models/orderStatus/schema.gadget.ts
export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Xyz123AbcDef",
  fields: {
    name: { type: "string", storageKey: "Ghi456JklMno" },
  },
};
// api/models/order/schema.gadget.ts
export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Pqr789StuVwx",
  fields: {
    orderStatus: {
      type: "belongsTo",
      parent: { model: "orderStatus" },
      storageKey: "Yza012BcdEfg",
    },
  },
};

// ✅ Use enum instead - api/models/order/schema.gadget.ts
import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Hij345KlmNop",
  fields: {
    status: {
      type: "enum",
      options: ["pending", "shipped", "delivered"],
      storageKey: "Qrs678TuvWxy",
    },
  },
};

// ✅ DO use a model when options have rich data
// api/models/product/schema.gadget.ts
import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Zab901CdeFgh",
  fields: {
    category: {
      type: "belongsTo",
      parent: { model: "category" },
      storageKey: "Ijk234LmnOpq",
    },
  },
};

// api/models/category/schema.gadget.ts
import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Rst567UvwXyz",
  fields: {
    name: { type: "string", storageKey: "Abc890DefGhi" },
    description: { type: "richText", storageKey: "Jkl123MnoPqr" },
    displayOrder: { type: "number", storageKey: "Stu456VwxYza" },
    icon: { type: "file", storageKey: "Bcd789EfgHij" },
  },
};
```

## Default Values

When specifying default values:

✅ Use `null` for empty states (not empty strings or zero dates)
✅ Use meaningful defaults when they make sense

```typescript
import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Klm012NopQrs",
  fields: {
    // ❌ Don't default to empty strings
    name: {
      type: "string",
      default: "",  // Wrong!
      storageKey: "Tuv345WxyZab",
    },

    // ✅ Use null for unknown values (omit default or set explicitly)
    title: {
      type: "string",
      storageKey: "Cde678FghIjk",
    },

    // ✅ Use meaningful defaults
    status: {
      type: "enum",
      options: ["draft", "published", "archived"],
      default: "draft",
      storageKey: "Lmn901OpqRst",
    },
    viewCount: {
      type: "number",
      default: 0,
      storageKey: "Uvw234XyzAbc",
    },
  },
};
```

## Built-In Model Modifications

### The `user` Model

When modifying the built-in `user` model:

⚠️ **Take great care** - it powers Gadget's authentication system
- ✅ You can add new fields
- ⚠️ Don't change existing fields or validations
- ⚠️ Leave email/password fields alone (used for login)
- ⚠️ Leave Google SSO fields alone (used for OAuth)

The `user` model typically includes:
- `email` - For email/password login
- `emailVerified` - Email verification status
- `googleProfileId` - For Google SSO
- `roleList` - Which roles this user has (for RBAC)

**Add custom fields, but don't modify the core authentication fields.**

## Summary

**DO:**
- ✅ Use singular names (post, not posts)
- ✅ Add comments to models and fields
- ✅ Specify display fields for autocompletes
- ✅ Normalize data and use relationships
- ✅ Use models for structured, persistent data
- ✅ Use enums and booleans over models for simple states

**DON'T:**
- ❌ Add "Model" or "Table" suffixes
- ❌ Create `id`, `createdAt`, `updatedAt` fields (auto-generated)
- ❌ Create models for audit logs or analytics
- ❌ Use JSON when you know the schema
- ❌ Create models for transient or computed data
- ❌ Modify core `user` model authentication fields

**📖 More info:**
- [Model fields](https://docs.gadget.dev/guides/models/fields.md)
- [Relationships](https://docs.gadget.dev/guides/models/relationships.md)
- [Storing files](https://docs.gadget.dev/guides/models/storing-files.md)
- [Model namespaces](https://docs.gadget.dev/guides/models/namespaces.md)
