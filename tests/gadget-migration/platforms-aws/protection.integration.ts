// Runs withTaskProtection from aws.md against a stand-in for the ECS agent's task protection endpoint,
// with the request and the responses on AWS's task scale-in protection page.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { block } from "../platform-blocks.ts";

const here = import.meta.dirname;

describe("withTaskProtection against a stand-in agent", () => {
  let server: Server;
  const requests: { method?: string; url?: string; body: any }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  let withTaskProtection: <T>(minutes: number, work: () => Promise<T>) => Promise<T>;

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const dir = join(here, ".work", "protection");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task-protection.server.ts"), block("aws.md", "app/jobs/task-protection.server.ts"));
    ({ withTaskProtection } = await import(join(dir, "task-protection.server.ts")));
  });

  after(() => {
    server.close();
    delete process.env.ECS_AGENT_URI;
  });

  it("protects the task while the work runs, and removes it after", async () => {
    process.env.ECS_AGENT_URI = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/task-1`;
    answer = { status: 200, body: { protection: { ProtectionEnabled: true, ExpirationDate: "2026-11-12T20:00:00Z", TaskArn: "arn:aws:ecs:us-east-1:123456789012:task/my-app/1" } } };
    requests.length = 0;
    let during = 0;
    const result = await withTaskProtection(30, async () => {
      during = requests.length;
      return "reconciled";
    });
    assert.equal(result, "reconciled");
    assert.equal(during, 1, "protection is on before the work starts");
    assert.deepEqual(requests, [
      { method: "PUT", url: "/api/task-1/task-protection/v1/state", body: { ProtectionEnabled: true, ExpiresInMinutes: 30 } },
      { method: "PUT", url: "/api/task-1/task-protection/v1/state", body: { ProtectionEnabled: false } },
    ]);
  });

  it("removes protection when the work throws", async () => {
    requests.length = 0;
    await assert.rejects(withTaskProtection(30, async () => Promise.reject(new Error("Shopify 502"))), /Shopify 502/);
    assert.deepEqual(requests.map((r) => r.body.ProtectionEnabled), [true, false]);
  });

  it("doesn't start the work when the agent answers with a failure or an error", async () => {
    let ran = false;
    answer = { status: 200, body: { failure: { Arn: "arn:aws:ecs:us-east-1:123456789012:task/my-app/1", Detail: null, Reason: "TASK_NOT_VALID" } } };
    await assert.rejects(withTaskProtection(30, async () => (ran = true)), /task protection failed: 200 TASK_NOT_VALID/);
    answer = { status: 400, body: { requestID: "12345-abc", error: { Code: "AccessDeniedException", Message: "not authorized to perform: ecs:UpdateTaskProtection" } } };
    await assert.rejects(withTaskProtection(30, async () => (ran = true)), /400 AccessDeniedException not authorized to perform: ecs:UpdateTaskProtection/);
    assert.equal(ran, false);
  });

  it("runs the work without an agent, as in development", async () => {
    delete process.env.ECS_AGENT_URI;
    requests.length = 0;
    assert.equal(await withTaskProtection(30, async () => 7), 7);
    assert.equal(requests.length, 0);
  });
});
