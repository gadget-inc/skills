import type { ActionFunctionArgs } from "react-router";
import { createUpload } from "../services/files.server";

// the browser uploads straight to storage with the presigned URL this returns
export const action = async ({ request }: ActionFunctionArgs) => {
  const { name, type, size } = await request.json();
  return Response.json(await createUpload(name, type, size));
};
