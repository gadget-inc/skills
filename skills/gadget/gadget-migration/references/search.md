# Replacing Gadget search

## What is this?

Gadget indexes every model for full text search, and any read can pass `search` or `searchFields`:

```typescript
const widgets = await api.widget.findMany({ search: "blue wid", first: 50 });
```

No table in a plain Postgres database answers that query until you build an index for it. This reference covers what Gadget's search did, a Postgres replacement that behaves the same way for the common cases, and when to use a search service instead.

Find the call sites first. Search for `search:` and `searchFields` in `api/`, `web/`, and any outside caller of the API. `AutoTable` has a search box too, so every page that renders one uses search even though the word never appears in the code. Many apps never call search and can skip this file.

## What Gadget's search did

| Behavior | Example |
|---|---|
| Matches whole words, ignoring case | `WIDGET` finds "Blue widget" |
| Treats the last word as a prefix | `blue wid` finds "Blue widget" |
| Any one word is enough to match, and records that match more words rank first | `blue widget` returns "Blue widget", then "Red widget" |
| No stemming | `widgets` does not find "Blue widget" |
| Searches every searchable field unless `searchFields` narrows it, including numbers, ids, enums, and JSON | `1042` finds the record whose `quantity` is 1042 |
| `searchFields` weights fields | `{ name: { weight: 2 }, description: true }` ranks a name match higher |
| Orders by relevance, then id, unless the call passes `sort` | |
| Query operators work: `+` (and), `\|` (or), `-` (not), `"a phrase"`, `prefix*` | A query that uses one gets no automatic prefix on the last word |

Search can't be combined with a filter on a related model's fields, so no call site depends on that combination.

## ✅ Postgres full text search

A stored `tsvector` column with a GIN index does the same job inside the database you already have. Three choices make it behave like Gadget:

- **The `simple` configuration.** `english` stems words, so `widgets` would start matching "widget" and results would change.
- **Split on punctuation before indexing.** Postgres keeps `jane@example.com` as one token and reads `AB-1042` as `ab` and `-1042`, so searches for `example` and `1042` find nothing. Gadget split both into words.
- **Weights per field.** `setweight` labels each field's words `A` to `D`, and `ts_rank` scores `A` highest.

```sql
-- in db/migrations/widget_search.sql
create function search_words(value text) returns text
  language sql immutable parallel safe
  return regexp_replace(coalesce(value, ''), '[^[:alnum:]]+', ' ', 'g');

alter table widget add column search tsvector generated always as (
  setweight(to_tsvector('simple', search_words(name)), 'A') ||
  setweight(to_tsvector('simple', search_words(contact_email)), 'B') ||
  setweight(to_tsvector('simple', search_words(description)), 'C')
) stored;

create index widget_search_idx on widget using gin (search);
```

The column is generated, so it is always in step with the row. Add only the fields users search. A JSON field goes in as `search_words(metadata::text)`.

Build the query from what the user typed. Every word is matched, the last one as a prefix, and any match is enough:

```typescript
// in app/services/search.server.ts
// "Blue wid" becomes "blue | wid:*". Returns null when the input has no letters or digits.
export function toSearchQuery(input: string): string | null {
  const words = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  return words.map((word, index) => (index === words.length - 1 ? `${word}:*` : word)).join(" | ");
}
```

Only letters and digits reach the query string, so input such as `'); drop table widget; --` can't break `to_tsquery` or the SQL around it. Pass the result as a parameter:

```sql
-- in db/queries/search_widgets.sql
select id, name
from widget
where shop_id = $1
  and search @@ to_tsquery('simple', $2)
order by ts_rank(search, to_tsquery('simple', $2)) desc, id
limit 50;
```

When `toSearchQuery` returns null, skip the search condition and run the plain list query. `to_tsquery` raises a syntax error on an empty string.

### ❌ Indexing the raw column

```sql
to_tsvector('simple', contact_email) -- one token: 'jane@example.com'
```

A search for `example` returns nothing, because the only word in the index is the whole address. `jane` only matches as a prefix of that one token, so it stops matching when another word follows it. A SKU such as `AB-1042` is indexed as `ab` and the number `-1042`, so `1042` finds nothing either. `search_words` turns the punctuation into spaces first.

### ❌ Using `like` for search

```sql
where name ilike '%' || $1 || '%' -- reads every row, and can't rank
```

It works on 500 rows and times out on 5 million. A leading `%` can't use a b-tree index.

## Matching that Gadget did not do

- **Typos and substrings.** Gadget did not correct typos unless the query used `~`. If users expect `widgte` to find "widget", add the `pg_trgm` extension with a GIN index on the text column and order by `similarity()`, or use a search service.
- **Stemming.** Switch `simple` to a language configuration such as `english` if you want `widgets` to find "widget". Results will differ from what users see today.

## When to use a search service

Postgres search is enough for searchable tables and autocompletes over one model. Use Typesense, Meilisearch, Algolia, or Elasticsearch when you need typo tolerance by default, facets, synonyms, or one search box across many models. A search service is a second copy of your data: write to it after the database transaction commits, the same way a job is queued ([actions-and-transactions.md](actions-and-transactions.md)), and add a reindex job for when the two drift.

## Vector similarity

Sorting or filtering by `cosineSimilarityTo` on a vector field is a different feature. It moves to pgvector, covered in [schema-mapping.md](schema-mapping.md) and [other-connections.md](other-connections.md).

## Common pitfalls

- **Missing `AutoTable` search.** The page had a search box that no line of your code asked for.
- **Using the `english` configuration by accident.** `to_tsvector(text)` with one argument uses the database default, which is often `english`. Name `'simple'` on both sides.
- **Forgetting the store condition.** The search query needs the same `shop_id` scoping as every other query ([shop-tenancy.md](shop-tenancy.md)).
- **Passing raw input to `to_tsquery`.** An apostrophe or a trailing `&` raises a syntax error. Build the query from words.
- **Ranking without a tiebreaker.** Rows with equal rank come back in any order, and pages overlap. Order by rank, then id.

## Related references

- [schema-mapping.md](schema-mapping.md): the tables the index sits on
- [frontend.md](frontend.md): the pages that call search
