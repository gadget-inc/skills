alter table audit_log enable row level security;
create policy audit_log_shop_isolation on audit_log using (shop_id = current_setting('app.shop_id')::bigint);
