// in app/routes/files.$.tsx
// A link that never expires, for files whose URL goes into a Shopify metafield or an email. A signed
// Blob Storage URL lasts at most 7 days, so this route signs a new 3-hour one on every request.
import type { LoaderFunctionArgs } from "react-router";
import { privateFileUrl } from "../services/files.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const key = params["*"] ?? "";
  // only files saved under public/, like a public file field on Gadget, and no way out of that folder
  if (!key.startsWith("public/") || key.split("/").includes("..")) return new Response(null, { status: 404 });
  const url = await privateFileUrl(key);
  // caches keep the redirect for an hour, well inside the 3 hours the signed URL lasts
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "public, max-age=3600" } });
};
