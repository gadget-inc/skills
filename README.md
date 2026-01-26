# Gadget Skills for Claude Code

A [Claude Code skill](https://claude.ai/claude-code) that provides best practices and patterns for building applications on the [Gadget platform](https://gadget.dev).

## Installation

```bash
npx skills add gadget-inc/skills --skill gadget-best-practices
```

## Usage

The skill automatically activates when working on Gadget projects or when you mention keywords like "Gadget app", "Shopify app", or "multi-tenancy".

You can also manually load it:
```bash
/skill gadget-best-practices
```

**Example queries:**
- "Add a bundle model with required name and discountPercentage fields that has many products"
- "Create a publish action for the post model that sets publishedAt and status to published"
- "Build a form to edit user profiles with name, email, and avatar upload"
- "Add a POST route for /webhook/stripe that verifies signatures and enqueues processing"
- "How do I implement row-level permissions in a multi-tenant Shopify app?"

## What's included?

Reference documentation covering data modeling, actions, routes, access control, Shopify/BigCommerce integrations, React hooks, deployment, and more.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on adding new reference documentation.

## Support

- [Gadget Documentation](https://docs.gadget.dev)
- [Gadget Discord Community](https://ggt.link/discord)
