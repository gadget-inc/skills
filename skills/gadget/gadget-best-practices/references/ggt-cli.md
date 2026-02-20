# ggt CLI Commands

**📖 Full docs:**
- [ggt reference](https://docs.gadget.dev/reference/ggt.md)
- [CLI](https://docs.gadget.dev/guides/development-tools/cli.md)

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

## Managing Environment Variables

```bash
ggt var list                          # List all variable keys
ggt var get <KEY>                     # Get value of a variable
ggt var set KEY=value                 # Set a variable (create or update)
ggt var set KEY=value --secret        # Set an encrypted secret (unreadable after)
ggt var delete <KEY>                  # Delete a variable
ggt var delete --all --force          # Delete all variables, no prompt
ggt var import --from <env> --all     # Import keys from another env as placeholders
ggt var import --from <env> --include-values KEY1 KEY2  # Import with values
ggt var import --from-file .env --all # Import from a .env file
```

All subcommands accept `-a`/`--app` and `-e`/`--env` (default to `.gadget/sync.json` values).

See [references/environments.md](environments.md) for full details on environment variables.

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

**When `ggt dev` is running:**
- Changes are automatically synced in both directions
- ✅ **DO NOT** use `ggt push` or `ggt pull` - changes sync automatically
- File edits are immediately reflected in your Gadget environment
- Changes in the Gadget editor are immediately pulled to local files

**When `ggt dev` is NOT running:**
```bash
ggt push   # Push local changes to Gadget
ggt pull   # Pull Gadget changes to local
ggt status # Check sync status
```

## Reference

Full documentation: [https://docs.gadget.dev/reference/ggt](https://docs.gadget.dev/reference/ggt.md)
