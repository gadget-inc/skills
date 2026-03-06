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
- Changes made locally -> synced to Gadget environment
- Changes made in Gadget editor -> synced to local files
- Required for changes to take effect automatically

```bash
# Check whether sync is already active in this directory
ggt status

# Start sync only if needed
ggt dev
```

## Scaffolding: `ggt add`

Use `ggt add` for schema-safe structure changes.

### Adding Models

```bash
# Model without fields
ggt add model post

# Model with fields
ggt add model post title:string body:richText published:boolean

# Namespaced model
ggt add model bigcommerce/product
```

### Adding Fields

```bash
# Add field to existing model
ggt add field post/published:boolean
ggt add field post/viewCount:number
ggt add field post/content:richText

# Namespaced models
ggt add field blogs/post/title:string
```

### Adding Actions

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

#### Disambiguating namespaces

If you have models and actions with the same namespace name:

```bash
# Explicitly specify model context
ggt add action model/post/audit

# Explicitly specify action namespace
ggt add action action/post/audit
```

### Adding Routes

```bash
# HTTP routes (when actions aren't sufficient)
ggt add route GET-hello
ggt add route POST-webhook
ggt add route GET-api/users
```

## Quality and Diagnostics

### Checking for Problems

```bash
# Show errors/warnings in your app without deploying
ggt problems
```

### Logs and Debugging

```bash
# Stream runtime logs
ggt logs

# Configure backend debugger integration
ggt debugger --configure vscode
ggt debugger --configure cursor
```

## Managing Environment Variables: `ggt var`

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

## Evaluating Snippets: `ggt eval`

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

## Managing Environments: `ggt env`

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

### Parallel agents with worktrees

Run multiple AI agents simultaneously on separate Gadget environments to explore different approaches or work on independent features without conflicts. Gadget development environments are unlimited, so you can spin up as many as needed.

Each parallel agent gets its own:
- **Local workspace**: A git worktree (or separate clone)
- **Gadget environment**: A separate cloud sandbox with its own database, API, and runtime

```bash
# 1. Create a git worktree for the agent's branch
git worktree add ../agent-feature
cd ../agent-feature

# 2. Create a dedicated Gadget environment (--use updates .gadget/sync.json automatically)
ggt env create agent-feature --use

# 3. Copy environment variables from development (non-secret values only)
ggt var import --from development --all --include-values
# Set any required secret variables manually:
# ggt var set MY_SECRET=value --secret

# 4. Push local code to the new environment
ggt push --force

# 5. Start sync so the agent can build and test against it
ggt dev
```

Open your AI coding tool (Claude Code, Cursor, Codex, etc.) in the worktree directory. The agent develops against the new environment without affecting other agent workspaces.

Repeat the setup for each additional agent:

```bash
# From your main app directory
git worktree add ../agent-feature-2
cd ../agent-feature-2
ggt env create agent-feature-2 --use
ggt var import --from development --all --include-values
ggt push --force
```

After merging, clean up:

```bash
ggt env delete agent-feature --force
git worktree remove ../agent-feature
```

**Tips:**

* Name environments descriptively: `agent-checkout-redesign`, `codex-auth-fix`
* Keep the workspace, git branch, and Gadget environment name aligned for easy tracking
* Run `ggt var list` in the new workspace to verify variables are set before starting an agent
* Automate the setup by wrapping `ggt env create`, `ggt var import`, and `ggt push` in a shell script

Full guide: https://docs.gadget.dev/guides/development-tools/working-with-agents/working-in-parallel

## Agent Plugin: `ggt agent-plugin`

Installs `AGENTS.md` and Gadget skill reference files into your project, giving AI coding agents (Claude Code, Cursor, Codex, etc.) Gadget-specific platform context automatically.

```bash
# Install for the first time
ggt agent-plugin install

# Update existing files to the latest version
ggt agent-plugin update

# Force reinstall even if files already exist
ggt agent-plugin install --force
```

Use `ggt agent-plugin update` (not `install --force`) to upgrade already-installed files. The `--force` flag is only needed to overwrite files in a fresh install scenario.

## Syncing

`ggt add` automatically syncs before making changes. If conflicts exist, you'll be prompted to resolve them.

**When `ggt dev` is running:**
- Changes are automatically synced in both directions
- ✅ **DO NOT** use `ggt push` or `ggt pull` - changes sync automatically
- File edits are immediately reflected in your Gadget environment
- Changes in the Gadget editor are immediately pulled to local files
- If `ggt dev` reports an existing process, reuse it instead of starting another sync

**When `ggt dev` is NOT running:**
```bash
ggt push     # Push local changes to Gadget
ggt pull     # Pull Gadget changes to local
ggt status   # Check sync status (also shows if ggt dev is running)
ggt problems # Check for app errors/warnings without deploying
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

## Reference

Full documentation: [https://docs.gadget.dev/reference/ggt](https://docs.gadget.dev/reference/ggt.md)
