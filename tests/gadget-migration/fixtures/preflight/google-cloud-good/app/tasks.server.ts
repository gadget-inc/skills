import { CloudTasksClient } from "@google-cloud/tasks";

const client = new CloudTasksClient();
const location = "us-central1";

export async function enqueue(queue: string, path: string, body: unknown) {
  const parent = client.queuePath(await client.getProjectId(), location, queue);
  await client.createTask({
    parent,
    task: {
      dispatchDeadline: { seconds: 15 * 60 },
      httpRequest: {
        httpMethod: "POST",
        url: `${process.env.WORKER_URL}${path}`,
        body: Buffer.from(JSON.stringify(body)).toString("base64"),
        oidcToken: { serviceAccountEmail: process.env.TASKS_SERVICE_ACCOUNT, audience: process.env.WORKER_URL },
      },
    },
  });
}

export async function createShopQueue(shopId: string) {
  const projectId = await client.getProjectId();
  await client.createQueue({ parent: client.locationPath(projectId, location), queue: { name: client.queuePath(projectId, location, `external-${shopId}`), rateLimits: { maxConcurrentDispatches: 2 } } });
}

// the app/uninstalled webhook keeps the store's queue: a deleted name can't be reused for 3 days
export async function pauseShopQueue(shopId: string) {
  const projectId = await client.getProjectId();
  await client.pauseQueue({ name: client.queuePath(projectId, location, `external-${shopId}`) });
}
