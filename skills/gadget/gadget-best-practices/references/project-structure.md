# Project Structure

## Directory Layout

```
gadget-app/
├── api/
│   ├── models/
│   │   ├── post/
│   │   │   ├── schema.gadget.ts
│   │   │   └── actions/
│   │   │       ├── create.js
│   │   │       ├── update.js
│   │   │       ├── delete.js
│   │   │       └── publish.js
│   │   └── user/
│   ├── actions/
│   │   └── sendEmail.js
│   └── routes/
│       └── GET-hello.js
├── accessControl/
│   └── permissions.gadget.ts
├── frontend/
│   ├── App.jsx
│   ├── components/
│   └── pages/
├── .gadget/
│   └── schema/
└── package.json
```

## Key Directories

### api/models/
Models and their actions:
- `schema.gadget.ts` - Model definition
- `actions/` - Model-scoped actions

### api/actions/
Global actions (no model context)

### api/routes/
HTTP routes (custom endpoints)

### accessControl/
Role and permission definitions

### frontend/
React application code

## File Naming Conventions

**Models:** camelCase, singular
```
api/models/blogPost/
api/models/user/
```

**Actions:** camelCase
```
api/models/post/actions/publish.js
api/actions/generateReport.js
```

**Routes:** `METHOD-path.js`
```
api/routes/GET-hello.js
api/routes/POST-webhook.js
api/routes/GET-users-[id].js
```

## Generated Files

**Never manually edit:**
- `.gadget/schema/**` - Auto-generated schemas
- `.gadget/client/` - Auto-generated API client

**Always use `ggt add` commands** to modify models and fields.

## Best Practices

- ✅ Use `ggt add` for models/fields
- ✅ Group related code by feature
- ✅ Keep actions focused and small
- ✅ Use descriptive file names
- ❌ Don't edit generated files manually
- ❌ Don't nest too deeply
