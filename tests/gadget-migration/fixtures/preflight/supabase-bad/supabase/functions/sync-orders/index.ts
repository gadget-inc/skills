Deno.serve(async (req) => {
  const { shop, token } = await req.json();
  const response = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ orders(first: 50) { nodes { id } } }" }),
  });
  return new Response(await response.text());
});
