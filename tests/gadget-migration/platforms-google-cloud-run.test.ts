// Run with: node --test "tests/**/*.test.ts"
// The Google Cloud Run checks in scripts/checks/google-cloud-run.ts, on the fixtures in
// fixtures/preflight/google-cloud-run-*, and on the complete examples in references/platforms/google-cloud-run.md,
// which must pass their own checks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { platformBlocks } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();
const own = (findings: { id: string }[]) => findings.filter((f) => f.id.startsWith("google-cloud-run/"));

function withApp(files: Record<string, string>, test: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "google-cloud-run-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    test(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const shopifyServer = 'import { shopifyApp } from "@shopify/shopify-app-react-router/server";\nexport default shopifyApp({ apiKey: process.env.SHOPIFY_API_KEY, apiSecretKey: process.env.SHOPIFY_API_SECRET || "", appUrl: process.env.SHOPIFY_APP_URL || "" });\n';

describe("Google Cloud Run checks", () => {
  it("finds each pitfall in the bad fixture, at its line", () => {
    const { findings } = preflight(fixture("google-cloud-run-bad"), ["google-cloud-run"]);
    assert.deepEqual(where(own(findings)), [
      "google-cloud-run/delete-queue app/tasks.server.ts:30",
      "google-cloud-run/iam-roles app/services/files.server.ts:6",
      "google-cloud-run/iam-roles app/tasks.server.ts:16",
      "google-cloud-run/iam-roles app/tasks.server.ts:24",
      "google-cloud-run/iam-roles scripts/deploy.sh:12",
      "google-cloud-run/iam-roles scripts/deploy.sh:21",
      "google-cloud-run/iam-roles scripts/deploy.sh:21",
      "google-cloud-run/instance-limits scripts/deploy.sh:17",
      "google-cloud-run/migrate-before-deploy scripts/deploy.sh:9",
      "google-cloud-run/migrate-on-start start.sh:3",
      "google-cloud-run/prisma-generate Dockerfile:9",
      "google-cloud-run/pubsub-expiration scripts/deploy.sh:21",
      "google-cloud-run/secret-latest scripts/deploy.sh:12",
      "google-cloud-run/secret-latest scripts/deploy.sh:17",
      "google-cloud-run/shopify-env-missing scripts/deploy.sh:12",
      "google-cloud-run/shopify-env-missing scripts/deploy.sh:17",
      "google-cloud-run/task-route-public app/routes/tasks.webhook.tsx:4",
      "google-cloud-run/timeout-deadline scripts/deploy.sh:12",
    ]);
    const byId = (id: string) => own(findings).filter((f) => f.id === id);
    assert.equal(byId("google-cloud-run/shopify-env-missing")[0].severity, "error");
    assert.equal(byId("google-cloud-run/shopify-env-missing")[0].error, "Detected an empty appUrl configuration");
    assert.match(byId("google-cloud-run/shopify-env-missing")[0].message, /SHOPIFY_APP_URL, SHOPIFY_API_SECRET/);
    assert.equal(byId("google-cloud-run/migrate-before-deploy")[0].severity, "error");
    assert.equal(byId("google-cloud-run/instance-limits")[0].severity, "manual");
    assert.deepEqual(byId("google-cloud-run/iam-roles").map((f) => f.message.match(/roles\/[\w.]+/)![0]).sort(), [
      "roles/cloudsql.client",
      "roles/cloudtasks.queueAdmin",
      "roles/iam.serviceAccountTokenCreator",
      "roles/iam.serviceAccountUser",
      "roles/pubsub.publisher",
      "roles/pubsub.subscriber",
    ]);
    for (const f of own(findings)) {
      assert.ok(f.fix.endsWith("."), `${f.id} fix ends with a period`);
      assert.match(f.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/google-cloud-run#/);
    }
  });

  it("finds nothing in the good fixture, which fixes each one", () => {
    assert.deepEqual(where(own(preflight(fixture("google-cloud-run-good"), ["google-cloud-run"]).findings)), []);
  });

  it("is detected from @google-cloud/tasks or a gcloud run deploy script", () => {
    assert.ok(preflight(fixture("google-cloud-run-good")).platforms.some((p) => p.platform === "google-cloud-run"));
    withApp({ "deploy.sh": "gcloud run deploy my-app-web --image=x\n" }, (dir) => assert.ok(preflight(dir).platforms.some((p) => p.platform === "google-cloud-run")));
  });

  it("lists the roles to check by hand when the repo has no IAM setup", () => {
    withApp({ "app/tasks.server.ts": "client.createQueue({});\n" }, (dir) => {
      const found = own(preflight(dir, ["google-cloud-run"]).findings);
      assert.deepEqual(where(found), ["google-cloud-run/iam-roles"]);
      assert.equal(found[0].severity, "manual");
      assert.match(found[0].message, /roles\/cloudtasks\.queueAdmin/);
    });
  });

  it("reads gcloud args in cloudbuild.yaml, and reports a dispatch deadline shorter than the timeout as two copies", () => {
    withApp(
      {
        "cloudbuild.yaml": "steps:\n  - name: gcr.io/google.com/cloudsdktool/cloud-sdk\n    entrypoint: gcloud\n    args: ['run', 'deploy', 'my-app-worker', '--image=x', '--no-allow-unauthenticated', '--timeout=30m']\n",
        "app/tasks.server.ts": "await client.createTask({ parent, task: { dispatchDeadline: { seconds: 15 * 60 } } });\n",
      },
      (dir) => {
        const found = own(preflight(dir, ["google-cloud-run"]).findings).filter((f) => f.id === "google-cloud-run/timeout-deadline");
        assert.deepEqual(where(found), ["google-cloud-run/timeout-deadline app/tasks.server.ts:1"]);
        assert.equal(found[0].severity, "error");
        assert.match(found[0].message, /15 minutes.*30 minutes/);
      }
    );
  });

  it("checks every env file a path such as ${ENV}.env.yaml can name, and skips lists it can't read", () => {
    const deploy = 'ENV="${1:?usage}"\nSECRETS="SHOPIFY_API_SECRET=shopify-api-secret:1"\ngcloud run deploy my-app-worker --image=x --env-vars-file="${ENV}.env.yaml" --set-secrets="$SECRETS"\ngcloud run deploy my-app-web --image=x --env-vars-file="${ENV}.env.yaml" --set-secrets="$UNKNOWN"\n';
    withApp(
      {
        "app/shopify.server.ts": shopifyServer,
        "scripts/deploy.sh": deploy,
        "production.env.yaml": "SHOPIFY_APP_URL: https://app.example.com\nSHOPIFY_API_KEY: production-client-id\n",
        "staging.env.yaml": "SHOPIFY_APP_URL: https://my-app-web-987654321.us-central1.run.app\n",
      },
      (dir) => {
        const found = own(preflight(dir, ["google-cloud-run"]).findings).filter((f) => f.id === "google-cloud-run/shopify-env-missing");
        // only the worker: the web command's secrets come from a variable the script never sets
        assert.deepEqual(where(found), ["google-cloud-run/shopify-env-missing scripts/deploy.sh:3"]);
        assert.match(found[0].message, /SHOPIFY_API_KEY \(not in staging\.env\.yaml/);
        assert.equal(found[0].error, "Missing values for: apiKey");
      }
    );
  });

  it("passes the complete examples in google-cloud-run.md", () => {
    const files: Record<string, string> = {};
    for (const b of platformBlocks("google-cloud-run.md")) files[b.path] = b.code;
    files["app/shopify.server.ts"] = shopifyServer;
    files["package.json"] = JSON.stringify({ dependencies: { "@google-cloud/tasks": "7.3.1", "@google-cloud/storage": "8.4.0", "@prisma/client": "6.19.3", prisma: "6.19.3" } });
    withApp(files, (dir) => assert.deepEqual(where(own(preflight(dir, ["google-cloud-run"]).findings)), []));
  });
});
