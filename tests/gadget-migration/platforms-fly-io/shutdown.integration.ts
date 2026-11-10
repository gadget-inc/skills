// Reproduces two Fly.io stop failures that fly-io.md and its checks describe:
// - the web server keeps running after SIGTERM while the queue's Redis connection is open, which on
//   Fly.io costs the full kill_timeout per web Machine, and exits at once with common.md's handler,
//   but only when the signal is SIGTERM, not Fly.io's default SIGINT
// - a worker started with npm run that only handles SIGTERM dies at once on SIGINT
// The web test starts its own Valkey container on port 57279 (the shared one is for other tests), or
// uses FLY_TEST_REDIS_URL. Skips without Docker or that variable.
// Run with: npm test (from this folder)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { block } from "../platform-blocks.ts";

const here = import.meta.dirname;
const CONTAINER = "migcheck-fly-io-valkey";
const PORT = 57279;
const ownRedis = !process.env.FLY_TEST_REDIS_URL;
const dockerOk = spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;
const skip = ownRedis && !dockerOk ? "needs Docker or FLY_TEST_REDIS_URL" : false;
const REDIS_URL = process.env.FLY_TEST_REDIS_URL ?? `redis://127.0.0.1:${PORT}`;

// Starts a process, waits for its "ready" line, sends a signal, and reports how long it took to exit,
// or null if it was still running after waitMs (then it is killed).
function stopAfter(command: string, args: string[], cwd: string, signal: NodeJS.Signals, waitMs: number): Promise<{ ms: number | null; output: string; code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, REDIS_URL }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let sentAt = 0;
    let timer: NodeJS.Timeout | undefined;
    const onData = (d: Buffer) => {
      output += d;
      if (!sentAt && output.includes("ready")) {
        sentAt = Date.now();
        child.kill(signal);
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ ms: null, output, code: null, signal: "timeout" });
        }, waitMs);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code, sig) => {
      if (timer) clearTimeout(timer);
      if (sentAt) resolve({ ms: Date.now() - sentAt, output, code, signal: sig });
      else reject(new Error(`exited with ${code ?? sig} before it was ready:\n${output}`));
    });
  });
}

describe("the web server's stop on Fly.io", { skip }, () => {
  const dir = join(here, ".typecheck", "web-shutdown");

  before(() => {
    if (ownRedis) {
      spawnSync("docker", ["rm", "-f", CONTAINER]);
      const started = spawnSync("docker", ["run", "-d", "--rm", "--name", CONTAINER, "-p", `127.0.0.1:${PORT}:6379`, "valkey/valkey:8"], { encoding: "utf8" });
      assert.equal(started.status, 0, started.stderr);
      for (let i = 0; i < 50 && spawnSync("docker", ["exec", CONTAINER, "valkey-cli", "ping"], { encoding: "utf8" }).stdout.trim() !== "PONG"; i++) spawnSync("sleep", ["0.2"]);
    }
    mkdirSync(join(dir, "app"), { recursive: true });
    // common.md's queue module, unchanged: it opens the Redis connection when the web server loads it
    writeFileSync(join(dir, "app/queues.server.ts"), block("common.md", "app/queues.server.ts"));
    // common.md's addition to app/entry.server.tsx, as a module the server can load or not
    // (Node needs the file extension that the app's bundler adds)
    writeFileSync(join(dir, "app/entry-shutdown.ts"), block("common.md", "app/entry.server.tsx").replace('"./queues.server"', '"./queues.server.ts"'));
    // what react-router-serve 7.18.2 does with signals (dist/cli.js): close the HTTP server, nothing else
    writeFileSync(
      join(dir, "server.ts"),
      `import { createServer } from "node:http";
import "./app/queues.server.ts";
if (process.env.WITH_HANDLER) await import("./app/entry-shutdown.ts");
const server = createServer((_req, res) => res.end("ok")).listen(0, () => console.log("ready"));
["SIGTERM", "SIGINT"].forEach((signal) => process.once(signal, () => server.close(console.error)));
`
    );
  });

  after(() => {
    if (ownRedis) spawnSync("docker", ["rm", "-f", CONTAINER]);
  });

  it("is still running 5 seconds after SIGTERM while the Redis connection is open", async () => {
    const result = await stopAfter(process.execPath, ["server.ts"], dir, "SIGTERM", 5000);
    assert.equal(result.ms, null, `exited after ${result.ms} ms: ${result.output}`);
  });

  it("exits in under a second on SIGTERM with common.md's handler", async () => {
    process.env.WITH_HANDLER = "1";
    try {
      const result = await stopAfter(process.execPath, ["server.ts"], dir, "SIGTERM", 5000);
      assert.ok(result.ms !== null && result.ms < 1000, `took ${result.ms} ms: ${result.output}`);
    } finally {
      delete process.env.WITH_HANDLER;
    }
  });

  it("still waits on SIGINT, Fly.io's default kill_signal, because the handler listens for SIGTERM", async () => {
    process.env.WITH_HANDLER = "1";
    try {
      const result = await stopAfter(process.execPath, ["server.ts"], dir, "SIGINT", 5000);
      assert.equal(result.ms, null, `exited after ${result.ms} ms: ${result.output}`);
    } finally {
      delete process.env.WITH_HANDLER;
    }
  });
});

describe("a worker started with npm run that only handles SIGTERM", () => {
  const dir = join(here, ".typecheck", "npm-worker");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "worker", private: true, scripts: { worker: "node worker.mjs" } }));
  writeFileSync(
    join(dir, "worker.mjs"),
    `process.on("SIGTERM", () => { console.log("SIGTERM: finishing the running job"); setTimeout(() => process.exit(0), 200); });
setInterval(() => {}, 1000);
console.log("ready");
`
  );

  it("dies at once on SIGINT without running its handler", async () => {
    const result = await stopAfter("npm", ["run", "--silent", "worker"], dir, "SIGINT", 5000);
    assert.ok(result.ms !== null && result.ms < 2000, `took ${result.ms} ms`);
    assert.doesNotMatch(result.output, /finishing the running job/);
    // npm exits on the signal itself, or with 130 (128 + SIGINT) depending on the npm version
    assert.ok(result.signal === "SIGINT" || result.code === 130, `code ${result.code}, signal ${result.signal}`);
  });

  it("runs its handler on SIGTERM, which kill_signal = \"SIGTERM\" sends", async () => {
    const result = await stopAfter("npm", ["run", "--silent", "worker"], dir, "SIGTERM", 5000);
    assert.match(result.output, /finishing the running job/);
    assert.equal(result.code, 0);
  });
});
