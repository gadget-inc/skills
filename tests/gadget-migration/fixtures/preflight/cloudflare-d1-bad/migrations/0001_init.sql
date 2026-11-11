-- widgets, copied from the Postgres schema
create table widget (
  id bigserial primary key,
  shop_id text not null,
  tags text[],
  created_at timestamptz not null default now()
);
create index widget_shop_id on widget (shop_id);
