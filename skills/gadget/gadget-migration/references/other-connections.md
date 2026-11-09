# OpenAI, vector search, ChatGPT apps, and Sentry

## What is this?

Besides Shopify and BigCommerce, a Gadget app can turn on three smaller plugins in `settings.gadget.ts`: `openai`, `chatgpt`, and `sentry`. Each one set something up that the code then used without any setup code of its own. This file covers what each one did and what replaces it. Most apps use none of them, so check the inventory first.

## OpenAI

`connections.openai` is the official `openai` client, already authenticated. Replace it with your own instance:

```typescript
// in app/services/openai.server.ts
import OpenAI from "openai";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
```

Every `connections.openai.chat.completions.create(...)` call becomes `openai.chat.completions.create(...)` with the same arguments.

Check which key the Gadget app used. The connection had two modes: your own API key, or Gadget's managed key, which came with a fixed credit and was meant for development. An app that still runs on the managed key has no OpenAI account of its own. Create one, add billing, and set a usage limit before the new app goes live. LangChain code that passed Gadget's `baseURL` with the managed key drops the `baseURL` and uses your key.

`openAIResponseStream` from `gadget-server/ai` turned a streamed completion into a response body for an HTTP route. Without it, write the text chunks to the response yourself:

```typescript
// in app/routes/api.chat.ts
import { openai } from "../services/openai.server";

export async function streamChat(prompt: string): Promise<Response> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    stream: true,
  });
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for await (const chunk of completion) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
```

Streaming needs a host that does not buffer responses. Check your host's response timeout as well: a long completion that fit Gadget's limit can be cut off by a 30 or 60 second proxy timeout.

## Vector search

Gadget vector fields sort and filter by similarity through the API:

```typescript
await api.document.findMany({
  sort: { embedding: { cosineSimilarityTo: queryVector } },
  filter: { embedding: { cosineSimilarity: { to: queryVector, greaterThan: 0.8 } } },
  first: 5,
});
```

In Postgres this is pgvector. Its `<=>` operator returns cosine distance, which is 1 minus the similarity, so the threshold flips:

```sql
-- in db/queries/similar_documents.sql
select id, body, 1 - (embedding <=> $1::vector) as similarity
from document
where shop_id = $2
  and 1 - (embedding <=> $1::vector) > 0.8
order by embedding <=> $1::vector
limit 5;
```

`cosineSimilarityTo` returned the most similar first. `order by embedding <=> $1` does the same, because the smallest distance is the highest similarity. A filter with `lessThan` flips the same way, and `l2Distance` maps to the `<->` operator with no flip.

### ❌ Ordering by similarity descending

```sql
order by 1 - (embedding <=> $1::vector) desc -- right answer, but can't use the index
```

It returns the same rows, and on 2 million rows it compares every one. pgvector's index is only used when the `order by` is the bare distance expression, ascending, with a `limit`. [schema-mapping.md](schema-mapping.md) has the index definition.

The embeddings themselves export as arrays of numbers and load into a `vector(n)` column unchanged. Keep using the same embedding model: vectors from two models can't be compared, so changing models means computing every embedding again.

## ChatGPT apps and MCP servers

With the `chatgpt` connection, the app is two things: an MCP server you wrote as HTTP routes with `@modelcontextprotocol/sdk`, and an OAuth 2.1 authorization server that Gadget ran for you. The MCP server is ordinary code and moves with the other routes. The authorization server is the part to replace:

| Gadget ran this | Replacement |
|---|---|
| The OAuth endpoints under `/api/oauth/v2/` (authorize, token, dynamic client registration) and the `/.well-known/` discovery documents | A sign-in provider that acts as an OAuth 2.1 server with dynamic client registration, or an OIDC provider library you host |
| The `/authorize` consent page in `web/routes/authorize.tsx` | The provider's consent screen, or your own page wired to it |
| A signed token that restored the user's session on every MCP request | Verifying the provider's access token in the MCP route and loading the user from it |
| Install actions that ran on the session and user when consent was granted | A callback or webhook from the provider |

Check that your provider supports dynamic client registration before you choose it, because ChatGPT registers itself as a client. Not every provider does.

Three things change for users on the day:

- **The MCP server URL changes** unless production is on a custom domain you repoint. The app's listing in ChatGPT must be updated to the new URL.
- **Every user connects again.** Tokens Gadget issued can't be verified by another server.
- **Registered clients are gone.** Clients that registered with Gadget register again with the new server on their next connection.

Widgets built with React keep their code. Replace the Gadget client calls inside them the same way as the rest of the frontend ([frontend.md](frontend.md)).

## Sentry

The Sentry connection initialized `@sentry/node` with your DSN and reported uncaught exceptions from actions and routes. The package is already in `package.json`. On the new platform, initialize it yourself, before any other import, so it can instrument them:

```typescript
// in instrument.server.ts
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.APP_ENV ?? "production",
});
```

Copy the DSN from the Sentry project's settings, since it is the same project. Existing `Sentry.captureException` calls keep working once `init` has run. Two things Gadget did are now yours:

- **Jobs and cron runs.** A job that throws inside a queue worker is caught by the queue for its retry and never reaches Sentry. Capture the error in the worker's failure handler.
- **Flushing on serverless hosts.** A function that returns before the event is sent loses it. Call `await Sentry.flush(2000)` before returning, or use Sentry's wrapper for your host.

## Common pitfalls

- **Going live on no OpenAI key.** The managed key was Gadget's. Nothing fails until the first request in production.
- **Keeping the similarity threshold but flipping nothing.** `embedding <=> $1 > 0.8` keeps the least similar rows.
- **Choosing a sign-in provider without dynamic client registration** for a ChatGPT app. The connection fails at the first step.
- **Initializing Sentry after other imports.** Errors are reported, but requests and queries are not traced.

## Related references

- [schema-mapping.md](schema-mapping.md): the `vector(n)` column and its index
- [users-and-auth.md](users-and-auth.md): choosing a sign-in provider
- [search.md](search.md): full text search, which is a separate feature from vector similarity
