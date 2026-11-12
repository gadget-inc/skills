// Parses every az command in azure.md's scripts with the real Azure CLI 2.88.0, unauthenticated, in its
// Docker image. az checks flags and many values before it looks for an account, so a misspelled flag fails
// with "unrecognized arguments" and a valid command fails with "Please run 'az login'". The image has no
// extensions, so the preview flag --scale-rule-identity, from the containerapp extension, is removed
// first. Skips without Docker. Run with: npm test (from this folder)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { block } from "../platform-blocks.ts";

const IMAGE = process.env.AZ_IMAGE ?? "mcr.microsoft.com/azure-cli:2.88.0";
const skip = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0 ? false : `needs Docker and ${IMAGE} (docker pull ${IMAGE})`;
const SCRIPTS = ["scripts/azure-env.sh", "scripts/azure-apps.sh", "scripts/deploy.sh"];

const dir = join(import.meta.dirname, ".typecheck", "az");
mkdirSync(join(dir, "scripts"), { recursive: true });
for (const path of SCRIPTS) writeFileSync(join(dir, path), block("azure.md", path));
// az acr build sends the current directory
writeFileSync(join(dir, "Dockerfile"), "FROM node:22-alpine\n");

// Wraps az: a parse error stops the run, the login error counts as a pass. "show" calls answer as
// missing on the first pass and as present on the second, so both branches of each "exists ||" run.
const harness = String.raw`
set -u
real=$(command -v az)
az() {
  local args=() skip_next=0 a out
  for a in "$@"; do
    if [ "$skip_next" = 1 ]; then skip_next=0; continue; fi
    if [ "$a" = "--scale-rule-identity" ]; then skip_next=1; continue; fi
    args+=("$a")
  done
  # the scripts run with set -e, and every real call fails at the login check
  out=$("$real" "${"$"}{args[@]}" 2>&1) || true
  if printf '%s' "$out" | grep -qiE 'unrecognized arguments|the following arguments are required|invalid choice|InvalidArgumentValue|is not a valid value|usage error|not in the allowed values|expected one argument'; then
    printf 'PARSE FAIL: az %s\n%s\n' "$*" "$out" | tee -a /w/failures.log >&2
    exit 1
  fi
  if ! printf '%s' "$out" | grep -q "az login"; then
    printf 'UNEXPECTED: az %s\n%s\n' "$*" "$out" | tee -a /w/failures.log >&2
    exit 1
  fi
  echo "ok: az $1 $2 $3" >> /w/parsed.log
  case "$*" in
    *"--query ipAddress"*) echo 20.121.33.44 ;;
    *"--query principalId"*) echo 00000000-0000-0000-0000-000000000001 ;;
    *"--query clientId"*) echo 00000000-0000-0000-0000-000000000002 ;;
    *"job start"*) echo my-app-migrate-abc123 ;;
    *"job execution show"*) echo Succeeded ;;
    *"--query id"*) echo /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/my-app/providers/Microsoft.Example/things/thing ;;
    *" show "*) [ "${"$"}{SHOW_OK:-0}" = 1 ] ;;
  esac
}
export -f az
export real
rm -f /w/failures.log /w/parsed.log
# each az call takes seconds to start, so staging runs the "missing" branches and production the "present" ones
for run in "staging 0" "production 1"; do
  set -- $run
  env=$1 pass=$2
  SHOW_OK=$pass DB_ADMIN_PASSWORD=x bash scripts/azure-env.sh "$env" > /dev/null || { echo "azure-env.sh $env failed"; exit 1; }
  SHOW_OK=$pass CREATE_SCHEDULED_JOBS=$pass bash scripts/azure-apps.sh "$env" v42 1a 2b 3c 4d > /dev/null || { echo "azure-apps.sh $env failed"; exit 1; }
  SHOW_OK=$pass bash scripts/deploy.sh "$env" v43 > /dev/null || { echo "deploy.sh $env failed"; exit 1; }
done
[ -s /w/failures.log ] && exit 1
echo ALL PARSED
`;
writeFileSync(join(dir, "harness.sh"), harness);

describe("az commands in azure.md", { skip }, () => {
  it("parses every command in scripts/azure-env.sh, scripts/azure-apps.sh, and scripts/deploy.sh, for staging and production", () => {
    const result = spawnSync("docker", ["run", "--rm", "-e", "AZURE_CORE_COLLECT_TELEMETRY=no", "-v", `${dir}:/w`, "-w", "/w", IMAGE, "bash", "harness.sh"], { encoding: "utf8", timeout: 1_500_000 });
    const parsed = spawnSync("sh", ["-c", `wc -l < "${join(dir, "parsed.log")}"`], { encoding: "utf8" }).stdout.trim();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ALL PARSED/);
    // three scripts, once per environment
    assert.ok(Number(parsed) > 100, `only ${parsed} az calls ran`);
  });

  it("catches a misspelled flag and a bad value, so a pass means something", () => {
    const run = (command: string) => execFileSync("docker", ["run", "--rm", IMAGE, "sh", "-c", `${command} 2>&1 || true`], { encoding: "utf8" });
    // argparse accepts a flag's unambiguous prefix, such as --min-replica, so the typo has to be a real one
    assert.match(run("az containerapp create --resource-group g --name my-app-web --environment e --min-replcas 2"), /unrecognized arguments: --min-replcas 2/);
    assert.match(run("az servicebus queue create --resource-group g --namespace-name my-app-production-bus --name webhooks --enable-duplicate-detection maybe"), /'maybe' is not a valid value for '--duplicate-detection'/);
  });
});
