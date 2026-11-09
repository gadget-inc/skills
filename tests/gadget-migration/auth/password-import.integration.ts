// Proves that a password hashed the way Gadget hashes it (node `bcrypt`, cost 10, the password as
// typed) still signs a user in after the move, using the code users-and-auth.md shows.
//
//   cd tests/gadget-migration/auth && npm install && npm test
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { before, test } from "node:test";
import bcrypt from "bcrypt";
import bcryptjs from "bcryptjs";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

const reference = new URL("../../../skills/gadget/gadget-migration/references/users-and-auth.md", import.meta.url);

// Finds a code block by the path comment on its first line, strips the types, and imports it from
// this folder so its bare imports resolve.
async function importBlock(path: string): Promise<any> {
  const markdown = readFileSync(reference, "utf8");
  const block = [...markdown.matchAll(/```typescript\n([\s\S]*?)```/g)].map((match) => match[1]).find((code) => code.startsWith(`// in ${path}\n`));
  assert.ok(block, `no code block for ${path} in users-and-auth.md`);
  const js = (nodeModule as any).stripTypeScriptTypes(block) as string;
  mkdirSync(new URL(".tmp/", import.meta.url), { recursive: true });
  const file = new URL(`.tmp/${path.replaceAll("/", "-")}.mjs`, import.meta.url);
  writeFileSync(file, js);
  return import(file.href);
}

const PASSWORD = "correct horse battery staple";
let gadgetHash: string;
let password: { hash: (password: string) => Promise<string>; verify: (data: { hash: string; password: string }) => Promise<boolean> };
let betterAuthRows: (user: any) => { user: any; accounts: any[] };

before(async () => {
  gadgetHash = await bcrypt.hash(PASSWORD, 10); // what Gadget stores in user.password.hash
  ({ password } = await importBlock("lib/password.ts"));
  ({ betterAuthRows } = await importBlock("scripts/import-users-better-auth.ts"));
});

function gadgetUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "42",
    email: "Jane@Example.com",
    emailVerified: true,
    firstName: "Jane",
    lastName: "Doe",
    googleProfileId: null,
    googleImageUrl: null,
    password: { hash: gadgetHash },
    createdAt: "2026-01-05T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

function authWith(db: Record<string, any[]>, emailAndPassword: Record<string, unknown>) {
  return betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-test-secret-test-secret-test",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, ...emailAndPassword },
    logger: { disabled: true },
  });
}

function imported(...users: ReturnType<typeof gadgetUser>[]) {
  const db: Record<string, any[]> = { user: [], account: [], session: [], verification: [] };
  for (const user of users) {
    const rows = betterAuthRows(user);
    db.user.push(rows.user);
    db.account.push(...rows.accounts);
  }
  return db;
}

test("Gadget's hash has the format the reference shows", () => {
  assert.match(gadgetHash, /^\$2b\$10\$[./A-Za-z0-9]{53}$/);
});

test("bcryptjs verifies a hash made by node bcrypt, and rejects a wrong password", async () => {
  assert.equal(await bcryptjs.compare(PASSWORD, gadgetHash), true);
  assert.equal(await bcryptjs.compare("wrong password", gadgetHash), false);
});

test("a hash made by bcryptjs verifies in node bcrypt, so either library can sit on either side", async () => {
  assert.equal(await bcrypt.compare(PASSWORD, await bcryptjs.hash(PASSWORD, 10)), true);
});

test("non-ASCII passwords verify across both libraries", async () => {
  const typed = "pässwörd-密码-🔑";
  assert.equal(await bcryptjs.compare(typed, await bcrypt.hash(typed, 10)), true);
});

test("both libraries only use the first 72 bytes, so long passwords keep working", async () => {
  const long = "a".repeat(100);
  const hash = await bcrypt.hash(long, 10);
  assert.equal(await bcryptjs.compare(long, hash), true);
  assert.equal(await bcryptjs.compare("a".repeat(72), hash), true);
  assert.equal(await bcryptjs.compare("a".repeat(71), hash), false);
});

test("the reference's password functions verify a Gadget hash", async () => {
  assert.equal(await password.verify({ hash: gadgetHash, password: PASSWORD }), true);
  assert.equal(await password.verify({ hash: gadgetHash, password: "wrong password" }), false);
  assert.match(await password.hash(PASSWORD), /^\$2[ab]\$10\$/);
});

test("Better Auth signs in an imported user with their Gadget password", async () => {
  const auth = authWith(imported(gadgetUser()), { password });
  const result = await auth.api.signInEmail({ body: { email: "jane@example.com", password: PASSWORD } });
  assert.equal(result.user.id, "42"); // Gadget's id survives
  assert.equal(result.user.emailVerified, true);
  assert.ok(result.token);
});

test("Better Auth finds the imported user whatever case they type their email in", async () => {
  const auth = authWith(imported(gadgetUser()), { password });
  const result = await auth.api.signInEmail({ body: { email: "JANE@example.com", password: PASSWORD } });
  assert.equal(result.user.id, "42");
});

test("Better Auth rejects a wrong password for an imported user", async () => {
  const auth = authWith(imported(gadgetUser()), { password });
  await assert.rejects(auth.api.signInEmail({ body: { email: "jane@example.com", password: "wrong password" } }));
});

test("without the bcrypt functions, Better Auth's default scrypt check locks imported users out", async () => {
  const auth = authWith(imported(gadgetUser()), {});
  await assert.rejects(auth.api.signInEmail({ body: { email: "jane@example.com", password: PASSWORD } }));
});

test("with only verify replaced, a user who signs up after the move can't sign in", async () => {
  const auth = authWith(imported(), { password: { verify: password.verify } });
  await auth.api.signUpEmail({ body: { email: "new@example.com", password: PASSWORD, name: "New" } });
  await assert.rejects(auth.api.signInEmail({ body: { email: "new@example.com", password: PASSWORD } }));
});

test("with both functions replaced, a new sign-up gets a bcrypt hash and can sign in", async () => {
  const db = imported();
  const auth = authWith(db, { password });
  await auth.api.signUpEmail({ body: { email: "new@example.com", password: PASSWORD, name: "New" } });
  assert.match(db.account[0].password, /^\$2[ab]\$10\$/);
  const result = await auth.api.signInEmail({ body: { email: "new@example.com", password: PASSWORD } });
  assert.ok(result.token);
});

test("a Google-only user gets a google account row and no credential row", () => {
  const rows = betterAuthRows(gadgetUser({ password: null, googleProfileId: "108204268033311374519", googleImageUrl: "https://example.com/a.png" }));
  assert.deepEqual(
    rows.accounts.map((account) => [account.providerId, account.accountId, account.userId, "password" in account]),
    [["google", "108204268033311374519", "42", false]]
  );
  assert.equal(rows.user.image, "https://example.com/a.png");
});

test("a Google-only user can't sign in with a password", async () => {
  const auth = authWith(imported(gadgetUser({ password: null, googleProfileId: "108204268033311374519" })), { password });
  await assert.rejects(auth.api.signInEmail({ body: { email: "jane@example.com", password: PASSWORD } }));
});

test("Better Auth refuses a password over 128 characters at sign-in unless maxPasswordLength is raised", async () => {
  const long = "a".repeat(130);
  const user = gadgetUser({ password: { hash: await bcrypt.hash(long, 10) } });
  await assert.rejects(authWith(imported(user), { password }).api.signInEmail({ body: { email: "jane@example.com", password: long } }));
  const raised = authWith(imported(user), { password, maxPasswordLength: 256 });
  const result = await raised.api.signInEmail({ body: { email: "jane@example.com", password: long } });
  assert.equal(result.user.id, "42");
});
