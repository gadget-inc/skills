// stands in for an Inngest serve route; vercel.json's functions section sets its duration
export async function GET() { return new Response("ok"); }
export async function POST() { return new Response("ok"); }
