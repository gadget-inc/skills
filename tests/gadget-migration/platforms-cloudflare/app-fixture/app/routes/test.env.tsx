// test only: what the Worker sees as SHOPIFY_APP_URL and R2_ENDPOINT
export const loader = async () => Response.json({ SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL ?? null, R2_ENDPOINT: process.env.R2_ENDPOINT ?? null });
