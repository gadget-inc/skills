# Shopify Integration

## Quick Reference

For complete Shopify patterns, see the **gadget-shopify** skill. This file covers the essentials.

## Setup

1. Add Shopify connection in Gadget web editor
2. Configure OAuth scopes (read_products, write_orders, etc.)
3. Shopify models auto-created (Product, Order, Customer, etc.)
4. Install flow automatic

**Result:** `shopifyShop` model tracks installed shops, webhooks registered, OAuth handled.

## The Golden Rule

**All models storing merchant data MUST have `belongsTo shop: ShopifyShop`.**

See [shopify-multi-tenancy.md](shopify-multi-tenancy.md) for complete tenancy patterns.

## Key Patterns

### Webhook Triggers

Shopify model actions will automatically trigger on relevant Shopify webhooks

Global actions can trigger on Shopify webhooks:

1. Open model action in IDE
2. Add "Shopify webhook" trigger
3. Select topic (`orders/create`, `products/update`, etc.)

```javascript
// api/models/shopifyOrder/actions/create.js
export const run = async ({ params, record, connections }) => {
  applyParams(params, record);
  await preventCrossUserDataAccess(params, record);
  await save(record);
};
```

### Syncing

Syncs can be kicked off from the Gadget web editor or using the sync API:

```typescript
export const onSuccess: ActionOnSuccess = async ({ record, api }) => {
  await api.shopifySync.run({
    domain: record.domain,
    shop: {
      _link: record.id,
    },
  });
};
```

**One-directional:** Changes in Shopify → Gadget

### Shopify API Access

```javascript
export const run = async ({ connections }) => {
  const shopify = connections.shopify.current;

  // GraphQL query
  const result = await shopify.graphql(`
    query {
      products(first: 10) {
        edges { node { id title } }
      }
    }
  `);
};
```

### Resilient Writes

```javascript
export const onSuccess = async ({ api, connections, record }) => {
  const shopify = connections.shopify.current;

  // Enqueue Shopify mutation for resilience
  await api.enqueue(shopify.graphql, {
    query: `mutation ($input: ProductInput!) {
      productCreate(input: $input) {
        product { id }
      }
    }`,
    variables: { input: { title: record.title } }
  });
};
```

### Background Actions with Shopify Context

```javascript
// Pass shopId to background action
export const onSuccess = async ({ api, connections }) => {
  await api.enqueue(api.processShopifyData, {
    shopId: connections.shopify.currentShopId
  });
};

// Re-establish context in background action
export const run = async ({ params, connections }) => {
  const shopify = connections.shopify.forShopId(params.shopId);
  // Use shopify...
};
```

### Metafields

1. Create metafield definition in Shopify
2. Enable in Gadget connection
3. Access via nested field on model

### GDPR Webhooks (Required)

Gadget subscribes to Shopify GDPR webhook actions. Users need to implement the logic in the actions.

Required: `customer/redact`, `shop/redact`, `customer/data_request`

## Multi-Tenancy Checklist

For every model storing merchant data:

✅ Add `belongsTo shop: ShopifyShop`
✅ Add permission filter (Gelly file) that checks `shopId == $session.shopId`
✅ Filter queries by `shopId` in actions
✅ Set `shop` when creating records

See [shopify-multi-tenancy.md](shopify-multi-tenancy.md) for complete patterns.

## Common Mistakes

1. **Missing shop relationship** - Data leaks
2. **Not filtering by shopId** - Returns all shops' data
3. **Blocking webhook handlers** - Use `api.enqueue()`
4. **Ignoring rate limits** - Automatic, but enqueue bulk operations
5. **Missing GDPR webhooks** - Violates Shopify requirements

## Best Practices

- ✅ Always add shop relationship
- ✅ Enqueue external API calls
- ✅ Use `api.enqueue()` for bulk Shopify operations
- ✅ Handle GDPR webhooks
- ✅ Make webhooks idempotent
- ✅ Test with development store

## See Also

- **gadget-shopify** skill - Complete Shopify patterns
- [shopify-multi-tenancy.md](shopify-multi-tenancy.md) - Tenant isolation
- [webhooks.md](webhooks.md) - General webhook patterns
- [background-jobs.md](background-jobs.md) - Enqueueing patterns
