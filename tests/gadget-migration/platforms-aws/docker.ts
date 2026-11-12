// Throwaway containers for the AWS tests: PostgreSQL 18, and AWS Emulator when its image is on this machine.
import { execFileSync } from "node:child_process";

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

export async function waitFor(check: () => boolean | Promise<boolean>, what: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}
