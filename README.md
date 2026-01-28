# Gadget Skills for Claude Code

A [Claude Code skill](https://claude.ai/claude-code) that provides best practices and patterns for building applications on [Gadget](https://gadget.dev).

## Installation

```bash
npx skills add gadget-inc/skills --skill gadget-best-practices
```

## Usage

The skill automatically activates when working on Gadget projects or when you mention keywords like "Gadget app", "Shopify app", or "multi-tenancy".

You can also manually load it:
```bash
/gadget-best-practices
```

**Example queries:**
- "Add a bundle model with required name and discountPercentage fields that has many products"
- "Build a top 10 leaderboard where each completed challenge counts for one point. Use a computed view to aggregate leaderboard data"
- "Create a publish action for the post model that sets publishedAt and status to published"
- "Build a form to edit user profiles with name, email, and avatar upload"
- "Add a POST route for /webhook/stripe that verifies signatures and enqueues processing"

More detail is a good thing, and using Gadget terminology when you know what you want is helpful!

## What's included?

Reference documentation covering data modeling, actions, routes, access control, Shopify/BigCommerce integrations, React hooks, deployment, and more.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on adding new reference documentation.

## Support

- [Gadget Documentation](https://docs.gadget.dev)
- [Gadget Discord Community](https://ggt.link/discord)
