Deno.serve(async (req) => {
  const { shop } = await req.json();
  // the Node host makes the Shopify calls, from an address on the app's IP allowlist
  const response = await fetch("https://app.example.com/api/jobs/sync-orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("JOBS_TOKEN")}` },
    body: JSON.stringify({ shop }),
  });
  return new Response(await response.text(), { status: response.status });
});
