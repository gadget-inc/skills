// in app/routes/api.uploads.tsx
// Signs one upload for the store that asks, with a key the browser can't choose.
import { randomUUID } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { uploadUrl } from "../services/files.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { name } = (await request.json()) as { name: string };
  // one folder per store and a random prefix, so no upload can overwrite another store's file
  const key = `${session.shop}/${randomUUID()}-${name.replace(/[^\w.-]/g, "_")}`;
  return Response.json({ key, url: await uploadUrl(key) });
};
