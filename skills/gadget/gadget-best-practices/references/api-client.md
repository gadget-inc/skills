# API Client

**📖 Full docs:** [docs.gadget.dev/guides/data-access/api](https://docs.gadget.dev/guides/data-access/api.md)

## Overview

Gadget auto-generates a type-safe API client for all models and actions.

## Finding Records

### findMany - Multiple Records

```javascript
const posts = await api.post.findMany({
  filter: { published: { equals: true } },
  sort: { createdAt: "Descending" },
  first: 20
});
```

### findOne - Single Record

```javascript
const post = await api.post.findOne("post-id");
```

### findFirst - First Matching Record

```javascript
const post = await api.post.findFirst({
  filter: { slug: { equals: "my-post" } }
});
```

## Filter Operators

**Equality:**
```javascript
filter: { status: { equals: "published" } }
filter: { status: { notEquals: "draft" } }
filter: { status: { in: ["published", "archived"] } }
```

**Comparison:**
```javascript
filter: { price: { greaterThan: 100 } }
filter: { price: { lessThan: 500 } }
filter: { createdAt: { greaterThanOrEqual: yesterday } }
```

**Text:**
```javascript
filter: { title: { startsWith: "How to" } }
filter: { body: { contains: "Gadget" } }
```

**Relationships:**
```javascript
filter: {
  author: { email: { equals: "user@example.com" } }
}
```

**Combining:**
```javascript
filter: {
  AND: [
    { published: { equals: true } },
    { price: { greaterThan: 0 } }
  ]
}

filter: {
  OR: [
    { status: { equals: "published" } },
    { author: { id: { equals: currentUserId } } }
  ]
}
```

## Selecting Fields

```javascript
const posts = await api.post.findMany({
  select: {
    id: true,
    title: true,
    author: {
      name: true,
      email: true
    }
  }
});
```

Filtering by a field requires a field to be indexed for filter/sort

## Sorting

```javascript
await api.post.findMany({
  sort: {
    publishedAt: "Descending",
  },
});
```

Sorting on a field requires a field to be indexed for filter/sort

## Searching

Gadget APIs have Elasticsearch built-in:

```javascript
const records = await api.post.findMany({
  search: "birds of antarctica",
});
```

Searching requires fields to be indexed for search.

## Pagination

Gadget uses cursor-based pagination for efficient data fetching.

⚠️ **Important:** Pagination can be time consuming. Make sure it is necessary. It is useful when paginating through records on the frontend. For aggregations, use [computed views](data-access.md) if possible.

### Basic Pagination

```javascript
const taskRecords = await api.task.findMany();
if (taskRecords.hasNextPage) {
  const nextPage = await taskRecords.nextPage();
}
if (taskRecords.hasPreviousPage) {
  const prevPage = await taskRecords.previousPage();
}
```

### Cursor Pagination

```javascript
// First page (first 10 records)
const firstPage = await api.post.findMany({
  first: 10,
});

// Next page (using cursor from last record)
const nextPage = await api.post.findMany({
  first: 10,
  after: firstPage.endCursor
});

// Previous page
const prevPage = await api.post.findMany({
  last: 10,
  before: nextPage.startCursor
});
```

### Page Info

Every `findMany` result includes pagination metadata:

```javascript
const result = await api.post.findMany({ first: 10 });

console.log(result.pageInfo);
// {
//   hasNextPage: true,
//   hasPreviousPage: false,
//   startCursor: "cursor-1",
//   endCursor: "cursor-10"
// }
```

### Max Page Size

The max page size for `findMany` requests is 250:

```javascript
const result = await api.post.findMany({ first: 250 });
```

### Complete Pagination Example

```javascript
async function getAllPosts() {
  let allPosts = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const result = await api.post.findMany({
      first: 100,
      after: cursor,
      sort: { createdAt: "Descending" }
    });

    allPosts = allPosts.concat(result);
    cursor = result.endCursor;
    hasMore = result.pageInfo.hasNextPage;
  }

  return allPosts;
}
```

### React Pagination with useFindMany

```tsx
function PaginatedPosts() {
  const [cursor, setCursor] = useState(null);

  const [{ data, fetching }] = useFindMany(api.post, {
    first: 20,
    after: cursor
  });

  return (
    <>
      {data?.map(post => <Post key={post.id} {...post} />)}
      {data?.pageInfo.hasNextPage && (
        <button onClick={() => setCursor(data.endCursor)}>
          Load More
        </button>
      )}
    </>
  );
}
```

## Creating Records

```javascript
const post = await api.post.create({
  title: "My Post",
  body: "Content",
  author: { _link: "user-id" }  // Link to related record
});
```

## Updating Records

```javascript
const post = await api.post.update("post-id", {
  title: "Updated Title"
});
```

## Upsert Records

```javascript
const post = await api.post.upsert({
  title: "Updated Title",
  on: ["id"]
});
```

## Deleting Records

```javascript
await api.post.delete("post-id");
```

## Bulk Operations

```javascript
// Bulk create
await api.post.bulkCreate([
  { title: "Post 1" },
  { title: "Post 2" }
]);

// Bulk update
await api.post.bulkUpdate([
  { id: "1", title: "Updated 1" },
  { id: "2", title: "Updated 2" }
]);

// Bulk delete
await api.post.bulkDelete(["id-1", "id-2"]);
```

## Linking Relationships

```javascript
// Link to existing record
{ author: { _link: "user-id" } }

// Create nested record
{ author: { email: "new@example.com" } }

// Many-to-many
{ tags: [{ _link: "tag-1" }, { _link: "tag-2" }] }
```

## Internal API

Bypasses permissions, validations, and action lifecycle. Actions are not run when using the internal API.

**Use only when direct database updates are needed** (in backend code - actions, routes):

```javascript
// Direct database update - no actions run
const posts = await api.internal.post.create({
  title: "My Post"
});
```

**⚠️ The internal API does not exist in the frontend and cannot be called from frontend code**

**⚠️ Important:** The internal API bypasses the action lifecycle (`run`, `onSuccess`, etc.). Use regular API calls (`api.post.create()`) if you need actions to execute.

## Best Practices

- ✅ Select only needed fields
- ✅ Use filters to scope queries
- ✅ Use `{ _link: "id" }` for relationships
- ✅ Use basic or cursor-based pagination to iterate over many pages of records
- ✅ Check `pageInfo.hasNextPage` before fetching more
- ✅ Use internal API only when direct database updates are needed (bypasses actions)
- ❌ Don't select all fields unnecessarily
- ❌ Don't fetch in loops (batch instead)
- ❌ Don't try to use internal API from frontend (it doesn't exist there)
- ❌ Don't use internal API if you need actions to run (use regular API instead)

**📖 More info:**
- [API access patterns](https://docs.gadget.dev/guides/data-access/api.md)
- [Filtering and sorting](https://docs.gadget.dev/guides/data-access/api.md#filtering-records)
- [Frontend React hooks](https://docs.gadget.dev/reference/react.md)
