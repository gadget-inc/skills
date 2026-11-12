// test only: sends n jobs for one store to the queue the consumer reads
import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopId = url.searchParams.get("shop")!;
  const n = Number(url.searchParams.get("n"));
  await context.cloudflare.env.EXTERNAL_QUEUE.sendBatch(Array.from({ length: n }, (_, i) => ({ body: { shopId, orderId: `${shopId}-${i}` } })));
  return Response.json({ sent: n });
};
