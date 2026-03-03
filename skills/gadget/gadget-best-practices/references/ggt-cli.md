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

## Checking for Problems

```bash
# Show errors/warnings in your app without deploying
ggt problems
```

## Managing Environment Variables

```bash
# List all env vars
ggt var list

# Get a specific variable
ggt var get SECRET_KEY

# Set variables
ggt var set SECRET_KEY=abc123
ggt var set KEY1=val1 KEY2=val2

# Delete variables
ggt var delete SECRET_KEY

# Import from another environment or .env file
ggt var import
```

Use `--app` and `--env` flags to target a specific app/environment.

## Evaluating Snippets

```bash
# Run read-only queries against your app's API client
ggt eval 'api.user.findMany()'
ggt eval --app my-app --env staging 'api.user.findFirst()'

# Allow write operations (read-only by default)
ggt eval -w 'api.user.delete("123")'

# Output as JSON
ggt eval --json 'api.widget.findMany()'
```

The snippet receives a pre-constructed `api` variable authenticated as the developer.

## Managing Environments

Use `ggt env` (alias: `ggt envs`) to manage environments without an active sync context.

```bash
# List all environments
ggt env list --app my-blog

# Create empty environment
ggt env create dev-2 --app my-blog

# Clone from existing environment
ggt env create dev-2 --from development --app my-blog

# Create and immediately switch to it
ggt env create dev-2 --use --app my-blog

# Switch active environment in current sync directory (updates .gadget/sync.json)
ggt env use dev-2

# Delete environment (skip confirmation with --force)
ggt env delete dev-2 --force --app my-blog

# Unpause a paused environment
ggt env unpause dev-2 --app my-blog
```

## Syncing

`ggt add` automatically syncs before making changes. If conflicts exist, you'll be prompted to resolve them.

**When `ggt dev` is running:**
- Changes are automatically synced in both directions
- ✅ **DO NOT** use `ggt push` or `ggt pull` - changes sync automatically
- File edits are immediately reflected in your Gadget environment
- Changes in the Gadget editor are immediately pulled to local files

**When `ggt dev` is NOT running:**
```bash
ggt push     # Push local changes to Gadget
ggt pull     # Pull Gadget changes to local
ggt status   # Check sync status (also shows if ggt dev is running)
ggt problems # Check for app errors/warnings without deploying
```

## Reference

Full documentation: [https://docs.gadget.dev/reference/ggt](https://docs.gadget.dev/reference/ggt.md)
