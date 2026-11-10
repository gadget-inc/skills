CREATE TABLE "Session" ("id" TEXT NOT NULL, "shop" TEXT NOT NULL, "state" TEXT NOT NULL, "isOnline" BOOLEAN NOT NULL DEFAULT false, "scope" TEXT, "expires" TIMESTAMP(3), "accessToken" TEXT NOT NULL, CONSTRAINT "Session_pkey" PRIMARY KEY ("id"));

create table audit_log (id bigserial primary key, shop_id bigint not null, event text not null, created_at timestamptz not null default now());
alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy audit_log_shop_isolation on audit_log using (shop_id = current_setting('app.shop_id')::bigint);
