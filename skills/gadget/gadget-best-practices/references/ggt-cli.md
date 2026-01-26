# ggt CLI Commands

The `ggt` CLI is Gadget's command-line interface for local development and code generation.

## Installation

```bash
npm install -g ggt
```

## Development Workflow

**Start syncing:** Run `ggt dev` in your app directory to continuously sync local files with Gadget
- Changes made locally → synced to Gadget environment
- Changes made in Gadget editor → synced to local files
- Required for changes to take effect automatically

## Adding Models

```bash
# Model without fields
ggt add model post

# Model with fields
ggt add model post title:string body:richText published:boolean

# Namespaced model
ggt add model bigcommerce/product
```

## Adding Fields

```bash
# Add field to existing model
ggt add field post/published:boolean
ggt add field post/viewCount:number
ggt add field post/content:richText

# Namespaced models
ggt add field blogs/post/title:string

## Adding Actions

```bash
# Model-scoped action (operates on a specific record)
ggt add action post/publish
ggt add action post/archive
ggt add action post/approve

# Global action (no model context)
ggt add action generateReport
ggt add action sendDigest
ggt add action processWebhook

# Namespaced action
ggt add action notifications/sendEmail
ggt add action admin/cleanupData
```

### Disambiguating namespaces

If you have models and actions with the same namespace name:

```bash
# Explicitly specify model context
ggt add action model/post/audit

# Explicitly specify action namespace
ggt add action action/post/audit
```

## Adding Routes

```bash
# HTTP routes (when actions aren't sufficient)
ggt add route GET-hello
ggt add route POST-webhook
ggt add route GET-api/users
```

## Best Practices

**DO:**
- ✅ Run `ggt dev` before making changes (ensures automatic syncing)
- ✅ Use singular model names (`post`, not `posts`)
- ✅ Use plural for hasMany/hasManyThrough fields (`comments`, `tags`)
- ✅ Use singular for belongsTo/hasOne fields (`author`, `post`)

**DON'T:**
- ❌ Create `id`, `createdAt`, `updatedAt` fields (auto-generated)
- ❌ Add "Model" or "Table" suffixes to model names
- ❌ Add "Id" suffix to belongsTo field names

## Syncing

`ggt add` automatically syncs before making changes. If conflicts exist, you'll be prompted to resolve them.

To manually sync:
```bash
ggt push   # Push local changes to Gadget
ggt pull   # Pull Gadget changes to local
ggt status # Check sync status
```

## Reference

Full documentation: [https://docs.gadget.dev/reference/ggt](https://docs.gadget.dev/reference/ggt)
