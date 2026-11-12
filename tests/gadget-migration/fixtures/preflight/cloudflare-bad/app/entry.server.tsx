import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { addDocumentResponseHeaders } from "./shopify.server";

export default async function handleRequest(request: Request, status: number, headers: Headers, context: EntryContext) {
  addDocumentResponseHeaders(request, headers);
  return new Promise((resolve, reject) => {
    const { pipe } = renderToPipeableStream(<ServerRouter context={context} url={request.url} />, {
      onShellReady() {
        const body = new PassThrough();
        resolve(new Response(createReadableStreamFromReadable(body), { headers, status }));
        pipe(body);
      },
      onShellError: reject,
    });
  });
}
