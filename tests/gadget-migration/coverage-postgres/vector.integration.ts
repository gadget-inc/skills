// Runs the pgvector query in references/other-connections.md. Skipped when the server has no
// pgvector extension available.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { sql } from "../coverage-snippets.ts";
import { scratchDatabase, skip as skipWithoutDatabase } from "./db.ts";

let admin: pg.Pool;
let skip: string | false = skipWithoutDatabase;
const SIMILAR = sql("other-connections.md", "db/queries/similar_documents.sql");

before(async () => {
  if (skip) return;
  ({ admin } = await scratchDatabase("gadget_migration_vector_test"));
  const { rows } = await admin.query("select 1 from pg_available_extensions where name = 'vector'");
  if (rows.length === 0) {
    skip = "pgvector is not installed on this Postgres server";
    return;
  }
  await admin.query(`
    create extension vector;
    create table document (id bigint primary key, shop_id bigint not null, body text, embedding vector(3));
    insert into document values
      (1, 1, 'same direction', '[2, 0, 0]'),
      (2, 1, 'close',          '[1, 0.3, 0]'),
      (3, 1, 'right angle',    '[0, 1, 0]'),
      (4, 1, 'opposite',       '[-1, 0, 0]'),
      (5, 2, 'other store',    '[1, 0, 0]');
    create index document_embedding_idx on document using hnsw (embedding vector_cosine_ops);
  `);
});

after(async () => {
  await admin?.end();
});

describe("other-connections.md vector search", () => {
  it("returns the most similar first and drops rows under the threshold", async (t) => {
    if (skip) return t.skip(skip);
    const { rows } = await admin.query(SIMILAR, ["[1, 0, 0]", 1]);
    assert.deepEqual(rows.map((row) => row.body), ["same direction", "close"]);
    // magnitude does not matter for cosine similarity: [2,0,0] is a perfect match for [1,0,0]
    assert.equal(Number(rows[0].similarity), 1);
    assert.ok(Number(rows[1].similarity) > 0.8 && Number(rows[1].similarity) < 1);
  });

  it("keeps the least similar rows when the threshold is not flipped", async (t) => {
    if (skip) return t.skip(skip);
    const { rows } = await admin.query("select body from document where shop_id = 1 and embedding <=> '[1, 0, 0]'::vector > 0.8 order by id");
    assert.deepEqual(rows.map((row) => row.body), ["right angle", "opposite"]);
  });

  it("uses the index for the bare distance order, and not for similarity descending", async (t) => {
    if (skip) return t.skip(skip);
    const plan = async (orderBy: string) => {
      const client = await admin.connect();
      try {
        await client.query("set enable_seqscan = off");
        const { rows } = await client.query(`explain select id from document order by ${orderBy} limit 5`);
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      } finally {
        await client.query("reset enable_seqscan");
        client.release();
      }
    };
    assert.match(await plan("embedding <=> '[1, 0, 0]'::vector"), /document_embedding_idx/);
    assert.doesNotMatch(await plan("1 - (embedding <=> '[1, 0, 0]'::vector) desc"), /document_embedding_idx/);
  });
});
