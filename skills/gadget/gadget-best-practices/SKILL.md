---
name: gadget-best-practices
description: Best practices for Gadget - Full-stack application development platform. Use when developers need guidance on models, actions, routes, access control, Shopify/BigCommerce integrations, frontend patterns, or Gadget framework decisions. Triggers "Gadget app", "model", "action", "Shopify app", "BigCommerce app", "multi-tenancy", "access control", "Gadget frontend"
---

## How to use

Read individual rule files for detailed explanations and code examples:

### Core Data Modeling
- [references/models.md](references/models.md) - Data model design patterns and naming conventions
- [references/fields.md](references/fields.md) - Field types, validations, and configuration
- [references/relationships.md](references/relationships.md) - Relationship patterns (belongsTo, hasMany, hasManyThrough)

### Backend Logic
- [references/actions.md](references/actions.md) - Model actions vs global actions, hooks, and patterns
- [references/routes.md](references/routes.md) - HTTP routes and when to use them vs actions
- [references/background-jobs.md](references/background-jobs.md) - Enqueueing actions and scheduled tasks

### Access Control & Security
- [references/access-control.md](references/access-control.md) - RBAC, permission filters, and Gelly expressions
- [references/shopify-multi-tenancy.md](references/shopify-multi-tenancy.md) - Shop isolation patterns for Shopify apps

### Platform Integrations
- [references/shopify-integration.md](references/shopify-integration.md) - Shopify app patterns (webhooks, sync triggers, metafields)
- [references/bigcommerce-integration.md](references/bigcommerce-integration.md) - BigCommerce app patterns
- [references/webhooks.md](references/webhooks.md) - Webhook handling patterns

### Frontend Development
- [references/frontend-hooks.md](references/frontend-hooks.md) - React hooks from @gadgetinc/react
- [references/frontend-components.md](references/frontend-components.md) - Autocomponents and UI patterns
- [references/frontend-forms.md](references/frontend-forms.md) - Form handling and validation

### Development Workflow
- [references/ggt-cli.md](references/ggt-cli.md) - CLI commands for adding models, fields, actions, and routes
- [references/deployment.md](references/deployment.md) - Deployment workflows and environments
- [references/environments.md](references/environments.md) - Environment variables and multi-environment strategies
- [references/project-structure.md](references/project-structure.md) - File organization and conventions

### API & Authentication
- [references/api-client.md](references/api-client.md) - Using the Gadget API client (filters, pagination, relationships)
- [references/authentication.md](references/authentication.md) - User authentication patterns
