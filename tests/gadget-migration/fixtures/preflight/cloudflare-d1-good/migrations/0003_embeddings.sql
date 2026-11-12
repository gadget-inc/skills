-- embeddings live in Vectorize, keyed by product_id, not in a vector(1536) column
create table product_embedding_state (
  product_id text primary key,
  embedded_at text not null
);
