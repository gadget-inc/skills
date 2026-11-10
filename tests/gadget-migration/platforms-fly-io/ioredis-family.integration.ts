// Reproduces why fly-io.md and the fly-io/ioredis-family check ask for family: 6 on older ioredis.
// Fly.io's private network, where Upstash Redis lives, is IPv6 only. This builds the same thing in Docker:
// an IPv6-only Docker network, a Valkey container on it, and a host name with only an IPv6 address.
// ioredis 5.8.1 looks up IPv4 by default and can't find the host; family: 6 and ioredis 6.0.0 connect.
// Skips without Docker. Run with: npm test (from this folder)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const here = import.meta.dirname;
const NETWORK = "migcheck-fly-io-v6";
const VALKEY = "migcheck-fly-io-valkey6";
const ADDRESS = "fd57:2000::10";
const skip = spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0 ? false : "needs Docker";

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });

describe("ioredis on an IPv6-only private network", { skip }, () => {
  const dir = join(here, ".typecheck", "ioredis-family");

  const cleanup = () => {
    docker("rm", "-f", VALKEY);
    docker("network", "rm", NETWORK);
  };

  before(() => {
    cleanup();
    assert.equal(docker("network", "create", "--ipv6", "--subnet", "fd57:2000::/64", NETWORK).status, 0);
    assert.equal(docker("run", "-d", "--rm", "--name", VALKEY, "--network", NETWORK, "--ip6", ADDRESS, "valkey/valkey:8", "valkey-server", "--bind", "::", "--protected-mode", "no").status, 0);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connect.mjs"),
      `const [pkg, family] = process.argv.slice(2);
const { default: Redis } = await import(pkg);
const options = family ? { family: Number(family) } : {};
const client = new Redis("redis://queue.internal:6379", { ...options, maxRetriesPerRequest: 1, retryStrategy: () => null });
client.on("error", (error) => console.log("error event:", error.message));
try {
  console.log("result:", await client.ping());
} catch (error) {
  console.log("result:", error.message);
}
client.disconnect();
`
    );
  });

  after(cleanup);

  function connect(pkg: string, family = "") {
    const result = docker("run", "--rm", "--network", NETWORK, "--add-host", `queue.internal:${ADDRESS}`, "-v", `${here}:/t`, "-w", "/t", "node:22-alpine", "node", ".typecheck/ioredis-family/connect.mjs", pkg, family);
    return result.stdout + result.stderr;
  }

  it("fails with getaddrinfo ENOTFOUND on ioredis 5.8.1 with no family", () => {
    const out = connect("ioredis-5-8-1");
    assert.match(out, /error event: getaddrinfo ENOTFOUND queue\.internal/);
    assert.doesNotMatch(out, /PONG/);
  });

  it("connects on ioredis 5.8.1 with family: 6", () => {
    assert.match(connect("ioredis-5-8-1", "6"), /result: PONG/);
  });

  it("connects on ioredis 6.0.0, whose default is family: 0", () => {
    assert.match(connect("ioredis"), /result: PONG/);
  });
});
