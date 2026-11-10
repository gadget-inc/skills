import { connection, externalQueue } from "./queues.server";

process.once("SIGTERM", async () => {
  await externalQueue.close();
  await connection.quit();
});
