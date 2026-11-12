// Blob Storage uploads and file links from azure.md against Azurite 3.37.0, Microsoft's local Blob
// Storage. Backs azure/blob-type-header and azure/blob-cors-header. Azurite signs with its published
// development account key, so the user delegation SAS of the guide's files.server.ts isn't what runs
// here; a service SAS with the same permissions and lifetime stands in. Needs Docker.
// Run with: npm test (from this folder)
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BlobSASPermissions, BlobServiceClient, generateBlobSASQueryParameters, SASProtocol, StorageSharedKeyCredential } from "@azure/storage-blob";
import { block } from "../platform-blocks.ts";
import { AZURITE_IMAGE, docker, hasImage, removeContainer } from "./docker.ts";

const NAME = "migcheck-azure-azurite";
const PORT = 57681;
const skip = hasImage(AZURITE_IMAGE) ? false : `needs Docker with ${AZURITE_IMAGE}`;
// Azurite's documented development account; not a secret
const ACCOUNT = "devstoreaccount1";
const KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const ENDPOINT = `http://127.0.0.1:${PORT}/${ACCOUNT}`;
const ORIGIN = "https://app.example.com";

const credential = new StorageSharedKeyCredential(ACCOUNT, KEY);
const service = new BlobServiceClient(ENDPOINT, credential);
const container = service.getContainerClient("files");

function signedUrl(key: string, permissions: string, minutes: number) {
  const sas = generateBlobSASQueryParameters(
    { containerName: "files", blobName: key, permissions: BlobSASPermissions.parse(permissions), startsOn: new Date(Date.now() - 5 * 60_000), expiresOn: new Date(Date.now() + minutes * 60_000), protocol: SASProtocol.HttpsAndHttp },
    credential
  );
  return `${container.getBlockBlobClient(key).url}?${sas}`;
}

async function setCors(allowedHeaders: string) {
  await service.setProperties({ cors: [{ allowedOrigins: ORIGIN, allowedMethods: "GET,PUT", allowedHeaders, exposedHeaders: "", maxAgeInSeconds: 3600 }] });
}

const preflight = (url: string, headers: string) =>
  fetch(url, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": headers } });

let dir: string;

before(async () => {
  if (skip) return;
  removeContainer(NAME);
  // --skipApiVersionCheck: Azurite 3.37.0 rejects @azure/storage-blob 12.34.0's API version without it
  docker("run", "-d", "--name", NAME, "-p", `127.0.0.1:${PORT}:10000`, AZURITE_IMAGE, "azurite-blob", "--blobHost", "0.0.0.0", "--skipApiVersionCheck", "--loose");
  for (let i = 0; ; i++) {
    try {
      await container.createIfNotExists();
      break;
    } catch (error) {
      if (i === 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  dir = join(import.meta.dirname, ".run", "azurite");
  mkdirSync(join(dir, "app/routes"), { recursive: true });
  mkdirSync(join(dir, "app/services"), { recursive: true });
});

after(() => {
  if (!skip) removeContainer(NAME);
});

describe("uploads to Blob Storage", { skip }, () => {
  it("answers a PUT without x-ms-blob-type with 400, and one with it with 201", async () => {
    const url = signedUrl("shop-1.myshopify.com/report.csv", "cw", 15);
    const bare = await fetch(url, { method: "PUT", headers: { "content-type": "text/csv" }, body: "a,b\n" });
    // Azurite sends no error code or body with it
    assert.equal(bare.status, 400);
    const typed = await fetch(url, { method: "PUT", headers: { "content-type": "text/csv", "x-ms-blob-type": "BlockBlob" }, body: "a,b\n" });
    assert.equal(typed.status, 201);
  });

  it("fails the browser's preflight with 403 CorsPreflightFailure when the CORS rule doesn't allow x-ms-blob-type", async () => {
    const url = signedUrl("shop-1.myshopify.com/a.png", "cw", 15);
    await setCors("content-type");
    const refused = await preflight(url, "content-type,x-ms-blob-type");
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get("x-ms-error-code"), "CorsPreflightFailure");
    // the rule scripts/azure-env.sh writes
    await setCors("content-type,x-ms-blob-type");
    const allowed = await preflight(url, "content-type,x-ms-blob-type");
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), ORIGIN);
  });

  it("stores a file sent by uploadFile from azure.md, with its content type", async () => {
    writeFileSync(join(dir, "app/upload.client.ts"), block("azure.md", "app/upload.client.ts"));
    const { uploadFile } = await import(join(dir, "app/upload.client.ts"));
    const key = "shop-1.myshopify.com/7b9e-logo.png";
    const realFetch = globalThis.fetch;
    // the app's signing route, which the test answers itself
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/uploads" ? Response.json({ key, url: signedUrl(key, "cw", 15) }) : realFetch(input, init)) as typeof fetch;
    try {
      const file = new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" });
      assert.equal(await uploadFile(file), key);
    } finally {
      globalThis.fetch = realFetch;
    }
    const properties = await container.getBlockBlobClient(key).getProperties();
    assert.equal(properties.contentType, "image/png");
    assert.equal(properties.contentLength, 4);
  });
});

describe("app/routes/files.$.tsx", { skip }, () => {
  it("redirects a public key to a signed URL that works, and refuses keys outside public/", async () => {
    await container.getBlockBlobClient("public/terms.pdf").upload("%PDF-1.7", 8, { blobHTTPHeaders: { blobContentType: "application/pdf" } });
    // stands in for the guide's files.server.ts: the same 3-hour read URL, signed with Azurite's key
    writeFileSync(
      join(dir, "app/services/files.server.ts"),
      `import { BlobSASPermissions, BlobServiceClient, generateBlobSASQueryParameters, SASProtocol, StorageSharedKeyCredential } from "@azure/storage-blob";
const credential = new StorageSharedKeyCredential(${JSON.stringify(ACCOUNT)}, ${JSON.stringify(KEY)});
const container = new BlobServiceClient(${JSON.stringify(ENDPOINT)}, credential).getContainerClient("files");
export async function privateFileUrl(key: string) {
  const sas = generateBlobSASQueryParameters({ containerName: "files", blobName: key, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 3 * 60 * 60 * 1000), protocol: SASProtocol.HttpsAndHttp }, credential);
  return container.getBlockBlobClient(key).url + "?" + sas;
}
`
    );
    // .ts, because Node strips types from .ts files only; the route has no JSX
    writeFileSync(join(dir, "app/routes/files.$.ts"), block("azure.md", "app/routes/files.$.tsx").replace('from "../services/files.server"', 'from "../services/files.server.ts"'));
    const { loader } = await import(join(dir, "app/routes/files.$.ts"));
    const response: Response = await loader({ params: { "*": "public/terms.pdf" } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
    const file = await fetch(response.headers.get("location")!);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), "%PDF-1.7");
    for (const key of ["shop-1.myshopify.com/report.csv", "public/../shop-1.myshopify.com/report.csv", ""]) {
      assert.equal((await loader({ params: { "*": key } })).status, 404, key);
    }
  });
});
