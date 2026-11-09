// Runs the upload and download code blocks from references/files-and-storage.md with the real AWS
// SDK. Presigning is offline, so no bucket or network is needed. The tests check what ends up in
// the signed URL, which is what storage enforces.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { blocks } from "../coverage-snippets.ts";

process.env.AWS_REGION = "us-east-1";
process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLEEXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "example-secret-for-offline-signing";
process.env.BUCKET = "example-bucket";

// the blocks import the SDK at runtime, so they are written next to this file's node_modules
async function importDocBlock(path: string): Promise<any> {
  const file = new URL(`./.${path.replace(/\W+/g, "-")}.generated.ts`, import.meta.url);
  writeFileSync(file, blocks("files-and-storage.md", path)[0]);
  try {
    return await import(file.href);
  } finally {
    rmSync(file);
  }
}

const { createUpload } = await importDocBlock("app/routes/api.uploads.ts");
const { downloadUrl } = await importDocBlock("app/services/files.server.ts");
const pdf = { name: "guide.pdf", type: "application/pdf", size: 1234 };

describe("createUpload in files-and-storage.md", () => {
  it("signs the type and the length, for 15 minutes", async () => {
    const { url } = await createUpload("7", "42", pdf);
    const params = new URL(url).searchParams;
    assert.equal(params.get("X-Amz-SignedHeaders"), "content-length;content-type;host");
    assert.equal(params.get("X-Amz-Expires"), "900");
  });

  it("leaves the empty-body checksum off the URL", async () => {
    const { url } = await createUpload("7", "42", pdf);
    assert.equal(new URL(url).searchParams.get("x-amz-checksum-crc32"), null);
  });

  it("shows the checksum the SDK adds without the client setting", async () => {
    const url = await getSignedUrl(new S3Client({}), new PutObjectCommand({ Bucket: "example-bucket", Key: "k" }), { expiresIn: 900 });
    // CRC32 of zero bytes: a real upload can't match it
    assert.equal(new URL(url).searchParams.get("x-amz-checksum-crc32"), "AAAAAA==");
  });

  it("builds the key on the server, under the store and record", async () => {
    const { key, url } = await createUpload("7", "42", { ...pdf, name: "../../shops/8/évil name?.pdf" });
    assert.match(key, /^shops\/7\/widgets\/42\/manual\/[0-9a-f-]{36}-[\w.-]+$/);
    assert.ok(!key.slice("shops/7/widgets/42/manual/".length).includes("/"), "the file name can't add path segments");
    assert.ok(new URL(url).pathname.endsWith(encodeURI(key)));
  });

  it("gives two uploads of the same file different keys", async () => {
    const first = await createUpload("7", "42", pdf);
    const second = await createUpload("7", "42", pdf);
    assert.notEqual(first.key, second.key);
  });

  it("refuses a type or size outside the limits before signing anything", async () => {
    await assert.rejects(createUpload("7", "42", { ...pdf, type: "text/html" }), (thrown: Response) => thrown.status === 422);
    await assert.rejects(createUpload("7", "42", { ...pdf, size: 26 * 1024 * 1024 }), (thrown: Response) => thrown.status === 422);
  });
});

describe("downloadUrl in files-and-storage.md", () => {
  it("signs a one hour URL that downloads under the original name", async () => {
    const params = new URL(await downloadUrl("shops/7/widgets/42/manual/x-guide.pdf", "guide.pdf")).searchParams;
    assert.equal(params.get("X-Amz-Expires"), "3600");
    assert.equal(params.get("response-content-disposition"), 'attachment; filename="guide.pdf"');
  });

  it("keeps a quote or newline in the name from breaking out of the header", async () => {
    const params = new URL(await downloadUrl("k", 'a".pdf\r\nSet-Cookie: x=1')).searchParams;
    assert.equal(params.get("response-content-disposition"), 'attachment; filename="a_.pdf__Set-Cookie: x=1"');
  });
});
