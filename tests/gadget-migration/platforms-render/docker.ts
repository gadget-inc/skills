// Starts throwaway Valkey containers for the Render tests. Each test file uses its own container and
// port, because node --test runs files in parallel. Nothing here touches a shared Redis.
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

// "valkey/valkey:8" is the Valkey version Render Key Value runs.
export const VALKEY_IMAGE = process.env.VALKEY_IMAGE ?? "valkey/valkey:8";
export const skipWithoutDocker = hasImage(VALKEY_IMAGE) ? false : `needs Docker with the ${VALKEY_IMAGE} image`;

export function startValkey(name: string, port: number, ...serverArgs: string[]) {
  removeContainer(name);
  docker("run", "-d", "--name", name, "-p", `127.0.0.1:${port}:6379`, VALKEY_IMAGE, "valkey-server", ...serverArgs);
}

export function removeContainer(name: string) {
  try {
    docker("rm", "-f", name);
  } catch {}
}

export async function connect(port: number): Promise<IORedis> {
  for (let i = 0; i < 100; i++) {
    const redis = new IORedis({ port, host: "127.0.0.1", maxRetriesPerRequest: null, lazyConnect: true, retryStrategy: () => null });
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
  throw new Error(`no Valkey on port ${port}`);
}
