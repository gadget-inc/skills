// a route written for Vercel's older Cron Jobs, which called the path with GET
export const loader = async () => new Response("ran");
