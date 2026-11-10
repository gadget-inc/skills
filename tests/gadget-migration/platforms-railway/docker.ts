// Throwaway containers for the Railway tests. Nothing here touches a shared Redis.
import { execFileSync } from "node:child_process";
import IORedis from "ioredis";

export function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function hasImage(image: string): boolean {
  try {
    docker("image", "inspect", image);
    return true;
  } catch {
    return false;
  }
}

export function removeContainer(name: string) {
  try {
    docker("rm", "-f", name);
  } catch {}
}

export function removeVolume(name: string) {
  try {
    docker("volume", "rm", "-f", name);
  } catch {}
}

export async function connect(port: number, password?: string): Promise<IORedis> {
  for (let i = 0; i < 100; i++) {
    const redis = new IORedis({ port, host: "127.0.0.1", password, maxRetriesPerRequest: null, lazyConnect: true, retryStrategy: () => null });
    // a refused connection while the container starts is expected; connect() below rejects with it
    redis.on("error", () => {});
    try {
      await redis.connect();
      await redis.ping();
      return redis;
    } catch {
      redis.disconnect();
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`no Redis on port ${port}`);
}
