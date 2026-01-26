# Frontend Hooks

## Overview

`@gadgetinc/react` provides React hooks for querying and mutating Gadget data.

## Key Hooks

### useFindMany - Query Multiple Records

```tsx
import { useFindMany } from "@gadgetinc/react";
import { api } from "../api";

function PostList() {
  const [{ data, fetching, error }] = useFindMany(api.post, {
    filter: { published: { equals: true } },
    sort: { createdAt: "Descending" },
    first: 20
  });

  if (fetching) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <ul>
      {data?.map(post => (
        <li key={post.id}>{post.title}</li>
      ))}
    </ul>
  );
}
```

### useFindOne - Query Single Record

```tsx
function PostDetail({ id }) {
  const [{ data: post, fetching }] = useFindOne(api.post, id, {
    select: { id: true, title: true, body: true, author: { name: true } }
  });

  if (fetching) return <div>Loading...</div>;

  return (
    <div>
      <h1>{post.title}</h1>
      <p>By {post.author.name}</p>
      <div>{post.body}</div>
    </div>
  );
}
```

### useAction - Run Actions

```tsx
function CreatePost() {
  const [{ data, fetching, error }, create] = useAction(api.post.create);

  const handleSubmit = async (e) => {
    e.preventDefault();
    await create({ title: "My Post", body: "Content..." });
  };

  return (
    <form onSubmit={handleSubmit}>
      <button disabled={fetching}>Create Post</button>
      {error && <div>Error: {error.message}</div>}
    </form>
  );
}
```

### useActionForm - Forms with Validation

```tsx
function EditPost({ id }) {
  const {
    submit,
    register,
    formState: { isSubmitting, errors }
  } = useActionForm(api.post.update, { findBy: id });

  return (
    <form onSubmit={submit}>
      <input {...register("title")} />
      {errors?.title && <span>{errors.title.message}</span>}

      <button disabled={isSubmitting}>Save</button>
    </form>
  );
}
```

## Live Queries

Real-time updates:

```tsx
const [{ data }] = useFindMany(api.post, {
  live: true  // Re-fetches when data changes
});
```

## Pagination

```tsx
function PaginatedPosts() {
  const [{ data, fetching }, refresh] = useFindMany(api.post, {
    first: 10
  });

  const loadMore = () => {
    refresh({ first: 10, after: data[data.length - 1].id });
  };

  return (
    <>
      {data?.map(post => <div key={post.id}>{post.title}</div>)}
      <button onClick={loadMore}>Load More</button>
    </>
  );
}
```

## Best Practices

- ✅ Use `live: true` for real-time data
- ✅ Select only fields you need
- ✅ Handle loading and error states
- ✅ Use `useActionForm` for forms
- ❌ Don't fetch in loops
- ❌ Don't over-select fields
