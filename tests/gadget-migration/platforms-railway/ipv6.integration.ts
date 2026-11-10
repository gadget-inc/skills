// Railway environments created before 16 October 2025 resolve private names such as redis.railway.internal
// to IPv6 addresses only. This gives a container that name with only an IPv6 address and shows what an
// IPv4-only lookup (ioredis before 5.8.2) gets, and that ioredis 6.0.0 defaults to family 0. Backs
// railway/ioredis-family. Needs Docker with the node:22-slim image.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import IORedis from "ioredis";
import { docker, hasImage } from "./docker.ts";

const skip = hasImage("node:22-slim") ? false : "needs Docker with the node:22-slim image";

describe("a private name with only an IPv6 address", { skip }, () => {
  it("fails an IPv4 lookup with ENOTFOUND and resolves with family 0", () => {
    const script = `
      const dns = require("node:dns");
      const lookup = (family) => new Promise((resolve) => dns.lookup("redis.railway.internal", { family }, (error, address) => resolve(error ? error.message : address)));
      Promise.all([lookup(4), lookup(0)]).then((results) => console.log(JSON.stringify(results)));
    `;
    const output = docker("run", "--rm", "--add-host", "redis.railway.internal:fd12:3456::7", "node:22-slim", "node", "-e", script);
    assert.deepEqual(JSON.parse(output), ["getaddrinfo ENOTFOUND redis.railway.internal", "fd12:3456::7"]);
  });
});

describe("ioredis 6.0.0", () => {
  it("looks up IPv4 and IPv6 by default", () => {
    const redis = new IORedis({ lazyConnect: true });
    assert.equal(redis.options.family, 0);
    redis.disconnect();
  });
});
