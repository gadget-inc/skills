create table processed_webhook (
  webhook_id text primary key,
  received_at timestamptz not null default now()
);
