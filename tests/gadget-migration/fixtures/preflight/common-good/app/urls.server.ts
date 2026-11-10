export const callback = new URL("api/callback", process.env.SHOPIFY_APP_URL).toString();
export const preview = `https://${process.env.VERCEL_URL}/api/preview`;
export const environment = process.env.APP_ENV;
