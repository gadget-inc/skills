import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";
import { addDocumentResponseHeaders } from "./shopify.server";

export default async function handleRequest(request: Request, status: number, headers: Headers, context: EntryContext) {
  addDocumentResponseHeaders(request, headers);
  const body = await renderToReadableStream(<ServerRouter context={context} url={request.url} />, { signal: AbortSignal.timeout(6000) });
  if (isbot(request.headers.get("user-agent") ?? "")) await body.allReady;
  headers.set("Content-Type", "text/html");
  return new Response(body, { headers, status });
}
