// Preloaded with --import so the export script's waits between retries take no time in tests.
// It records each requested wait so a test can check the backoff.
import { appendFileSync } from "node:fs";

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  if (process.env.FAKE_WAIT_LOG) appendFileSync(process.env.FAKE_WAIT_LOG, `${ms}\n`);
  return realSetTimeout(callback, 0, ...args);
};
