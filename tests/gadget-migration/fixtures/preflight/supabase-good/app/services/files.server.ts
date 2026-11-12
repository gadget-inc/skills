import { supabaseAdmin } from "../supabase.server";

export async function deleteWidgetFile(path: string) {
  const { error } = await supabaseAdmin.storage.from("widget-files").remove([path]);
  if (error) throw error;
}
