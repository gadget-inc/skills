ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_shop_isolation ON "audit_log" USING (shop_id = current_setting('app.shop_id')::bigint);
