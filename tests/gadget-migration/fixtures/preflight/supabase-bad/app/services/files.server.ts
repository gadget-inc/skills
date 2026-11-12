import { pool } from "../db.server";

export async function deleteWidgetFile(path: string) {
  await pool.query("delete from storage.objects where bucket_id = 'widget-files' and name = $1", [path]);
}
