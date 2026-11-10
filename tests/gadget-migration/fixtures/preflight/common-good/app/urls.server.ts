export const callback = new URL("api/callback", process.env.SHOPIFY_APP_URL).toString();
export const preview = `https://${process.env.VERCEL_URL}/api/preview`;
export const environment = process.env.APP_ENV;
// Vercel's documented base URL, with the scheme added before the host
export const base = new URL("/api/callback", `https://${process.env.VERCEL_URL}`);
// a Redis URL on Railway's private network
export const redisUrl = `redis://default:${process.env.REDIS_PASSWORD}@${process.env.RAILWAY_PRIVATE_DOMAIN}:6379`;
// a log line
export function logStart() {
  console.log(`Listening on ${process.env.RAILWAY_PUBLIC_DOMAIN}`);
}
// the variable as a condition, with the scheme added where it's used
export const origin = new URL(process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
// a query string on the origin, which is a valid URL
export const installUrl = (shop: string) => `${process.env.SHOPIFY_APP_URL}?shop=${shop}`;
