import type { ActionFunctionArgs } from "react-router";
import { parseFormData } from "@mjackson/form-data-parser";
import { saveUpload } from "../services/files.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await parseFormData(request);
  return Response.json(await saveUpload(form.get("file") as File));
};
