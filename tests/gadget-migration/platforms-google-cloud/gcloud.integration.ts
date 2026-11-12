// Parses every gcloud command in the reference's IAM and deploy scripts with the real Google Cloud CLI,
// unauthenticated, in its Docker image. gcloud checks flags and their values before it looks for an
// account, so a misspelled flag or a bad value fails with a parse error and a valid command fails with
// "You do not currently have an active account selected". Skips without Docker.
// Run with: npm test (from this folder)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { block } from "../platform-blocks.ts";

const IMAGE = process.env.GCLOUD_IMAGE ?? "gcr.io/google.com/cloudsdktool/google-cloud-cli:alpine";
const docker = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" });
const skip = docker.status === 0 ? false : `needs Docker and ${IMAGE} (docker pull ${IMAGE})`;

const dir = join(import.meta.dirname, ".typecheck", "gcloud");
mkdirSync(join(dir, "scripts"), { recursive: true });
// gcloud reads --env-vars-file while it parses, so the env file is checked too
for (const path of ["scripts/gcp-iam.sh", "scripts/deploy.sh", "production.env.yaml"]) writeFileSync(join(dir, path), block("google-cloud.md", path));
// the reference gives staging.env.yaml as the same keys with staging's values
writeFileSync(join(dir, "staging.env.yaml"), block("google-cloud.md", "production.env.yaml").replaceAll("production", "staging"));

// Wraps gcloud: a parse error stops the run, the login error counts as a pass. "describe" calls answer
// as missing on the first pass and as present on the second, so both branches of each script run.
const harness = `
set -u
real=$(command -v gcloud)
gcloud() {
  out=$("$real" "$@" 2>&1)
  if printf '%s' "$out" | grep -qE 'unrecognized arguments|argument --|Invalid choice|Invalid value|is not a valid|must be specified|ERROR: \\(gcloud\\) '; then
    printf 'PARSE FAIL: gcloud %s\\n%s\\n' "$*" "$out" >&2
    exit 1
  fi
  if ! printf '%s' "$out" | grep -q 'do not currently have an active account'; then
    printf 'UNEXPECTED: gcloud %s\\n%s\\n' "$*" "$out" >&2
    exit 1
  fi
  echo "ok: gcloud $1 $2 $3" >&2
  case "$*" in
    "projects describe "*) echo 123456789 ;;
    *" describe "*) [ "\${DESCRIBE_OK:-0}" = 1 ] ;;
  esac
}
git() { echo abc1234; }
export -f gcloud git 2>/dev/null || true
for script in scripts/gcp-iam.sh scripts/deploy.sh; do
  for env in staging production; do
    for pass in 0 1; do
      DESCRIBE_OK=$pass . "./$script" "$env" || exit 1
    done
  done
done
echo ALL PARSED
`;
writeFileSync(join(dir, "harness.sh"), harness);
// gcloud builds submit --tag reads the Dockerfile in the current directory before it asks for an account
writeFileSync(join(dir, "Dockerfile"), "FROM node:22-alpine\n");

function runHarness() {
  return spawnSync(
    "docker",
    ["run", "--rm", "-e", "CLOUDSDK_CORE_DISABLE_PROMPTS=1", "-e", "CLOUDSDK_CORE_PROJECT=my-app-production", "-v", `${dir}:/w`, "-w", "/w", IMAGE, "bash", "-c", "bash harness.sh"],
    { encoding: "utf8", timeout: 300_000 }
  );
}

describe("gcloud commands in google-cloud.md", { skip }, () => {
  it("parses every command in scripts/gcp-iam.sh and scripts/deploy.sh, for staging and production", () => {
    const result = runHarness();
    const parsed = (result.stderr.match(/^ok: /gm) ?? []).length;
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /ALL PARSED/);
    // both scripts, both environments, both passes: well over 60 gcloud calls
    assert.ok(parsed > 60, `only ${parsed} gcloud calls ran:\n${result.stderr}`);
  });

  it("catches a misspelled flag, so a pass means something", () => {
    const out = execFileSync("docker", ["run", "--rm", "-e", "CLOUDSDK_CORE_PROJECT=p", IMAGE, "sh", "-c", "gcloud run deploy my-app-worker --image=x --region=us-central1 --timout=15m 2>&1 || true"], { encoding: "utf8" });
    assert.match(out, /unrecognized arguments: --timout=15m/);
    const value = execFileSync("docker", ["run", "--rm", "-e", "CLOUDSDK_CORE_PROJECT=p", IMAGE, "sh", "-c", "gcloud run deploy my-app-worker --image=x --region=us-central1 --timeout=abc 2>&1 || true"], { encoding: "utf8" });
    assert.match(value, /argument --timeout: Failed to parse duration/);
  });
});
