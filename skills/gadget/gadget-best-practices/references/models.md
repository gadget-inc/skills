# Data Models

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

```
// ❌ Over-engineered
model location
model locationType { // Just to store "retail" or "wholesale"
  hasMany locations
}

// ✅ Simple and pragmatic
model location {
  field type: Enum { retail, wholesale }
}
```

```
// ❌ Over-engineered
model userActivity { // Just for analytics
  field action: String
  belongsTo user
}

// ✅ Use Gadget's built-in audit logs and analytics
// No model needed!
```

## Data Normalization

### Prefer Normalized Data

Avoid duplication - normalize relationships:

```
// ❌ Denormalized
model order {
  field customerName: String
  field customerEmail: String
  field customerPhone: String
}

// ✅ Normalized
model order {
  belongsTo customer
}

model customer {
  field name: String
  field email: String
  field phone: String
}
```

### But Be Pragmatic

Sometimes denormalization is OK for performance:

```
// ✅ Acceptable for fast queries
model order {
  belongsTo customer
  field customerEmailId: String // Cached for quick access
}
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

```
// ❌ Don't use a model for simple states
model orderStatus { name: String }
model order { belongsTo orderStatus }

// ✅ Use enum
model order {
  field status: Enum { pending, shipped, delivered }
}

// ✅ DO use a model when options have rich data
model product {
  belongsTo category
}

model category {
  field name: String
  field description: RichText
  field displayOrder: Number
  field icon: File
}
```

## Default Values

When specifying default values:

✅ Use `null` for empty states (not empty strings or zero dates)
✅ Use meaningful defaults when they make sense

```javascript
// ❌ Don't default to empty strings
field name: String { default: "" }

// ✅ Use null for unknown values
field name: String { default: null }

// ✅ Use meaningful defaults
field status: Enum { default: "draft" }
field viewCount: Number { default: 0 }
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
