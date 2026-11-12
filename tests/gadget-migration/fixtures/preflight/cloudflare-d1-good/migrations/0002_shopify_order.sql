-- the shopifyOrder fields the app reads, with the rest in one JSON column
create table shopify_order (
  id text primary key,
  shop_id text not null,
  name text not null,
  total_price_cents integer not null,
  financial_status text,
  shopify_created_at text not null,
  extra text not null default '{}'
);
