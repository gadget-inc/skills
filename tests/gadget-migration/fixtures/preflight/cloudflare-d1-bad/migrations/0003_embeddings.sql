create table product_embedding (
  product_id text primary key,
  embedding vector(1536) not null
);
