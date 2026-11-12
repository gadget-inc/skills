CREATE TABLE "audit_log" ("id" BIGSERIAL PRIMARY KEY, "shop_id" BIGINT NOT NULL, "message" TEXT NOT NULL);
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_shop_isolation ON "audit_log" USING ("shop_id" = current_setting('app.shop_id')::bigint);
