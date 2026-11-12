export async function tagOrder(shop: string, accessToken: string, orderId: string) {
  const response = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query: "mutation($id: ID!) { tagsAdd(id: $id, tags: [\"synced\"]) { userErrors { message } } }", variables: { id: `gid://shopify/Order/${orderId}` } }),
  });
  if (!response.ok) throw new Error(`Shopify answered ${response.status}`);
}
