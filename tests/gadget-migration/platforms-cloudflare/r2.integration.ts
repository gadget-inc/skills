// Runs the presigned upload and download helpers from references/platforms/cloudflare.md against
// versitygw, an S3-compatible server, started in Docker with R2's region, "auto". The helpers read
// their settings from "cloudflare:workers", which this file replaces with a plain object.
// Skips without Docker. S3_TEST_PORT changes the port (default 57310).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { AwsClient } from "aws4fetch";
import { block } from "../platform-blocks.ts";

const PORT = Number(process.env.S3_TEST_PORT ?? 57310);
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const CONTAINER = "migcheck-cloudflare-s3";
const IMAGE = "versity/versitygw:v1.0.20";
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const dockerReady = docker("info").status === 0;
const admin = new AwsClient({ accessKeyId: "r2localkey", secretAccessKey: "r2localsecret", service: "s3", region: "auto" });

let startedContainer = false;
let helpers: { createUpload: Function; downloadUrl: Function };
const stub = new URL("./.cloudflare-workers-stub.generated.ts", import.meta.url);
const generated = new URL("./.files-server.generated.ts", import.meta.url);

describe("presigned R2 helpers against an S3-compatible server", { skip: !dockerReady && "Docker isn't running" }, () => {
  before(async () => {
    if (docker("inspect", "-f", "{{.State.Running}}", CONTAINER).stdout.trim() !== "true") {
      docker("rm", "-f", CONTAINER);
      const run = docker("run", "-d", "--rm", "--name", CONTAINER, "-p", `${PORT}:7070`, "-e", "ROOT_ACCESS_KEY_ID=r2localkey", "-e", "ROOT_SECRET_ACCESS_KEY=r2localsecret", "-e", "VGW_REGION=auto", "--entrypoint", "sh", IMAGE, "-c", "mkdir -p /tmp/vgw && exec versitygw posix /tmp/vgw");
      assert.equal(run.status, 0, run.stderr);
      startedContainer = true;
    }
    for (let i = 0; i < 40; i++) {
      if (await fetch(ENDPOINT).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok([200, 409].includes((await admin.fetch(`${ENDPOINT}/my-app-files`, { method: "PUT" })).status), "created the bucket");
    writeFileSync(stub, `export const env = { R2_ENDPOINT: "${ENDPOINT}", R2_BUCKET: "my-app-files", R2_ACCESS_KEY_ID: "r2localkey", R2_SECRET_ACCESS_KEY: "r2localsecret" };\n`);
    writeFileSync(generated, block("cloudflare.md", "app/services/files.server.ts").replace(/from "cloudflare:workers"/, 'from "./.cloudflare-workers-stub.generated.ts"'));
    helpers = await import(generated.href);
  });

  after(() => {
    rmSync(stub, { force: true });
    rmSync(generated, { force: true });
    if (startedContainer) docker("rm", "-f", CONTAINER);
  });

  const pdf = new TextEncoder().encode("%PDF-1.4 a small manual");
  const file = { name: "../manual v2.pdf", type: "application/pdf", size: pdf.length };

  it("signs the type and size for 15 minutes, under a key the server builds", async () => {
    const { url, key } = await helpers.createUpload("7", "42", file);
    const params = new URL(url).searchParams;
    assert.equal(params.get("X-Amz-SignedHeaders"), "content-length;content-type;host");
    assert.equal(params.get("X-Amz-Expires"), "900");
    assert.match(key, /^shops\/7\/widgets\/42\/manual\/[0-9a-f-]{36}-\.\._manual_v2\.pdf$/);
  });

  it("accepts the upload it signed and refuses another type or size", async () => {
    const { url } = await helpers.createUpload("7", "42", file);
    assert.equal((await fetch(url, { method: "PUT", body: pdf, headers: { "content-type": "application/pdf" } })).status, 200);
    const wrongType = await fetch(url, { method: "PUT", body: pdf, headers: { "content-type": "text/html" } });
    assert.equal(wrongType.status, 403);
    assert.match(await wrongType.text(), /SignatureDoesNotMatch/);
    assert.equal((await fetch(url, { method: "PUT", body: new Uint8Array(pdf.length + 1), headers: { "content-type": "application/pdf" } })).status, 403);
  });

  it("shows why allHeaders is set: without it, any type uploads", async () => {
    const loose = await admin.sign(`${ENDPOINT}/my-app-files/loose.pdf?X-Amz-Expires=900`, { method: "PUT", headers: { "content-type": "application/pdf" }, aws: { signQuery: true } });
    assert.equal(new URL(loose.url).searchParams.get("X-Amz-SignedHeaders"), "host");
    assert.equal((await fetch(loose.url, { method: "PUT", body: pdf, headers: { "content-type": "text/html" } })).status, 200);
  });

  it("signs a download for 3 hours that saves under the record's file name", async () => {
    const { url: upload, key } = await helpers.createUpload("7", "42", file);
    await fetch(upload, { method: "PUT", body: pdf, headers: { "content-type": "application/pdf" } });
    const url = await helpers.downloadUrl(key, 'manual "v2".pdf');
    assert.equal(new URL(url).searchParams.get("X-Amz-Expires"), "10800");
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="manual _v2_.pdf"');
    assert.equal(await res.text(), "%PDF-1.4 a small manual");
  });

  it("rejects a type or size the app doesn't allow before signing", async () => {
    await assert.rejects(helpers.createUpload("7", "42", { ...file, type: "text/html" }), (r: Response) => r.status === 422);
    await assert.rejects(helpers.createUpload("7", "42", { ...file, size: 26 * 1024 * 1024 }), (r: Response) => r.status === 422);
  });

  it("has a CORS file in R2's rules format, not S3's CORSRules", () => {
    const cors = JSON.parse(block("cloudflare.md", "r2-cors.json").split("\n").slice(1).join("\n"));
    assert.deepEqual(cors.rules[0].allowed, { origins: ["https://app.example.com"], methods: ["PUT"], headers: ["content-type"] });
    assert.equal(cors.CORSRules, undefined);
  });
});
