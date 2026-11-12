import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });

for await (const line of createInterface({ input: createReadStream("user.ndjson") })) {
  const user = JSON.parse(line);
  const { error } = await supabase.auth.admin.createUser({
    email: user.email,
    password_hash: user.password?.hash,
    app_metadata: { gadget_id: user.id, roles: user.roles },
  });
  if (error) console.log(user.id, error.code, error.message);
}
