// Typechecks the TypeScript in google-cloud-run.md with the packages it names, and runs the Cloud Tasks
// helpers' retry paths against a stubbed CloudTasksClient (Cloud Tasks has no emulator).
// Run with: npm test (from this folder)
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CloudTasksClient } from "@google-cloud/tasks";
import { block, typecheck, writeProject } from "../platform-blocks.ts";

const here = import.meta.dirname;

describe("google-cloud-run.md TypeScript", () => {
  it("typechecks with @google-cloud/tasks 7.3.1, react-router 7.18.2, and TypeScript 5.9.3", () => {
    const roots = writeProject("google-cloud-run.md", join(here, ".typecheck", "project"));
    typecheck(here, roots, { types: ["node"] });
  });
});

interface Call {
  method: "createTask" | "createQueue";
  request: any;
}

describe("app/tasks.server.ts against a stubbed client", () => {
  const calls: Call[] = [];
  // codes to throw from the next calls, in order; undefined means succeed
  let createTaskErrors: (number | undefined)[] = [];
  let createQueueErrors: (number | undefined)[] = [];
  const saved = { ...CloudTasksClient.prototype };
  let tasks: any;
  const env = { ...process.env };

  before(async () => {
    const proto = CloudTasksClient.prototype as any;
    proto.getProjectId = async () => "my-app-production";
    proto.createTask = async (request: any) => {
      calls.push({ method: "createTask", request });
      const code = createTaskErrors.shift();
      if (code !== undefined) throw Object.assign(new Error(`code ${code}`), { code });
      return [request.task];
    };
    proto.createQueue = async (request: any) => {
      calls.push({ method: "createQueue", request });
      const code = createQueueErrors.shift();
      if (code !== undefined) throw Object.assign(new Error(`code ${code}`), { code });
      return [request.queue];
    };
    Object.assign(process.env, {
      APP_ENV: "production",
      WORKER_URL: "https://my-app-worker-123456789.us-central1.run.app",
      TASKS_SERVICE_ACCOUNT: "tasks-invoker@my-app-production.iam.gserviceaccount.com",
      TASKS_LOCATION: "us-central1",
    });
    const dir = join(here, ".typecheck", "run");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.server.ts"), block("google-cloud-run.md", "app/tasks.server.ts"));
    tasks = await import(join(dir, "tasks.server.ts"));
  });

  after(() => {
    Object.assign(CloudTasksClient.prototype, saved);
    process.env = env;
  });

  it("names the task after a SHA-256 of the key and sets the deadline, URL, and token", async () => {
    calls.length = 0;
    await tasks.enqueue("webhooks", "/tasks/webhook", { shop: "example-store.myshopify.com" }, { key: "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043" });
    const { request } = calls[0];
    assert.equal(request.parent, "projects/my-app-production/locations/us-central1/queues/webhooks");
    assert.match(request.task.name, /^projects\/my-app-production\/locations\/us-central1\/queues\/webhooks\/tasks\/[0-9a-f]{64}$/);
    assert.deepEqual(request.task.dispatchDeadline, { seconds: 900 });
    assert.equal(request.task.httpRequest.url, "https://my-app-worker-123456789.us-central1.run.app/tasks/webhook");
    assert.equal(request.task.httpRequest.oidcToken.audience, "https://my-app-worker-123456789.us-central1.run.app");
    assert.deepEqual(JSON.parse(Buffer.from(request.task.httpRequest.body, "base64").toString()), { shop: "example-store.myshopify.com" });
  });

  it("treats ALREADY_EXISTS as a duplicate delivery", async () => {
    createTaskErrors = [6];
    await tasks.enqueue("webhooks", "tasks/webhook", {}, { key: "same-webhook" });
  });

  it("creates a missing store queue and retries on NOT_FOUND", async () => {
    calls.length = 0;
    createTaskErrors = [5, undefined];
    await tasks.enqueueForShop("111222333", "tasks/notify-external-system", { orderId: "5001" }, { key: "notify-5001" });
    assert.deepEqual(calls.map((c) => c.method), ["createTask", "createQueue", "createTask"]);
    const queue = calls[1].request.queue;
    assert.equal(queue.name, "projects/my-app-production/locations/us-central1/queues/external-111222333");
    assert.deepEqual(queue.rateLimits, { maxConcurrentDispatches: 2 });
    assert.equal(queue.retryConfig.maxAttempts, 7);
  });

  // waits 2 and 4 seconds between tries, as the helper does
  it("retries a reactivating queue, whose createQueue answers ALREADY_EXISTS, then gives up after 3 tries", async () => {
    calls.length = 0;
    createTaskErrors = [5, 5, 5];
    createQueueErrors = [6, 6];
    await assert.rejects(tasks.enqueueForShop("111222333", "tasks/notify-external-system", {}), (error: any) => error.code === 5);
    assert.deepEqual(calls.map((c) => c.method), ["createTask", "createQueue", "createTask", "createQueue", "createTask"]);
  });

  it("rethrows other errors, so the caller's retry runs", async () => {
    createTaskErrors = [7];
    await assert.rejects(tasks.enqueue("webhooks", "tasks/webhook", {}), (error: any) => error.code === 7);
  });

  it("answers only on the worker, and reads the attempt from Cloud Tasks' header", () => {
    const request = new Request("https://my-app-worker-123456789.us-central1.run.app/tasks/x", { method: "POST", headers: { "X-CloudTasks-TaskRetryCount": "2", "X-CloudTasks-QueueName": "external-111222333" } });
    process.env.K_SERVICE = "my-app-web";
    assert.equal(tasks.workerTask(request), null);
    process.env.K_SERVICE = "my-app-worker";
    assert.deepEqual(tasks.workerTask(request), { attempt: 3, queue: "external-111222333" });
  });
});
