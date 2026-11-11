-- Postgres had bigserial and default now(); SQLite fills in an integer primary key
create table widget (
  id integer primary key,
  shop_id text not null,
  tags text, -- a JSON array, since SQLite has no text[]
  created_at text not null default current_timestamp
);
create index widget_shop_id on widget (shop_id);
