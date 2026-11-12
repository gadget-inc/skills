// Shopify request verification with the Web Crypto API only.
//
// The same file runs unchanged on Node 20+, Bun, Deno, Cloudflare Workers, Vercel Functions
// (Node and Edge), Netlify, and AWS Lambda, because it uses no Node-specific modules.
// Copy it into your project and call it from whatever framework you use; see
// references/shopify-signatures.md for the per-framework glue.
//
// Every function takes one secret or several. Pass two while you rotate your app's client
// secret: Shopify says it can take up to an hour before deliveries are signed with the new one.

type Secrets = string | readonly string[];

const encoder = new TextEncoder();

// Matches a store's permanent domain, anchored at both ends so a value like
// `example.myshopify.com.attacker.test` does not pass.
export const SHOP_DOMAIN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

/**
 * Verifies an HTTPS webhook delivery.
 *
 * @param rawBody the request body exactly as received, before any JSON parsing
 * @param hmacHeader the value of the `X-Shopify-Hmac-SHA256` header
 */
export async function verifyWebhook(
  rawBody: ArrayBuffer | Uint8Array,
  hmacHeader: string | null | undefined,
  secrets: Secrets
): Promise<boolean> {
  if (!hmacHeader) return false;
  const signature = base64ToBytes(hmacHeader.trim());
  if (!signature || signature.length !== 32) return false;
  return verifyHmac(secrets, signature, rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody));
}

export interface QueryOptions {
  /** reject a `timestamp` further than this from now, in either direction. Defaults to 90 seconds, like Shopify's own library */
  maxAgeSeconds?: number;
  nowSeconds?: number;
}

/**
 * Verifies the `hmac` query parameter Shopify adds to the OAuth callback and to links it opens
 * in your app, such as admin bulk actions. For embedded app loads, verify the `id_token` with
 * verifySessionToken instead.
 *
 * Shopify signs the decoded values with `&` and `%` escaped (and `=` in keys), as whole
 * `key=value` pairs sorted and joined with `&`. The escaping keeps a value containing `&` from
 * signing the same as two separate parameters.
 */
export async function verifyQueryHmac(query: string | URLSearchParams, secrets: Secrets, options: QueryOptions = {}): Promise<boolean> {
  const params = typeof query === "string" ? new URLSearchParams(query) : query;
  const hmac = params.get("hmac");
  if (!hmac || !/^[0-9a-f]{64}$/i.test(hmac) || params.getAll("hmac").length > 1) return false;
  if (!isFresh(params, options)) return false;

  const scalars = new Map<string, string>();
  const arrays = new Map<string, string[]>();
  for (const [key, value] of params) {
    if (key === "hmac" || key === "signature") continue;
    if (key.endsWith("[]")) {
      const name = key.slice(0, -2);
      arrays.set(name, [...(arrays.get(name) ?? []), value]);
      continue;
    }
    // a repeated key, or a single value shaped like an array, could be read two ways
    if (scalars.has(key) || value.startsWith("[")) return false;
    scalars.set(key, value);
  }
  for (const name of arrays.keys()) if (scalars.has(name)) return false;

  const pairs = [...scalars].map(([key, value]) => `${escapeQueryPart(key, /[&=%]/g)}=${escapeQueryPart(value, /[&%]/g)}`);
  // an array, such as ids[]=1&ids[]=2 on a bulk action link, is signed once as ids=["1", "2"]
  for (const [name, values] of arrays) {
    const formatted = `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
    pairs.push(`${escapeQueryPart(name, /[&=%]/g)}=${escapeQueryPart(formatted, /[&%]/g)}`);
  }
  const message = pairs.sort(compareCodeUnits).join("&");

  return verifyHmac(secrets, hexToBytes(hmac), encoder.encode(message));
}

function escapeQueryPart(text: string, characters: RegExp): string {
  return text.replace(characters, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Verifies the `signature` query parameter on a request Shopify forwarded through your app proxy.
 * A valid signature only proves Shopify sent the request: still check that `logged_in_customer_id`
 * owns the data you return.
 */
export async function verifyAppProxySignature(query: string | URLSearchParams, secrets: Secrets, options: QueryOptions = {}): Promise<boolean> {
  const params = typeof query === "string" ? new URLSearchParams(query) : query;
  const signature = params.get("signature");
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;

  // Pairs are concatenated with no separator, so one signed string can be split several ways.
  // Pin the parameters Shopify adds to the shapes Shopify sends, so text can't move between them.
  for (const key of ["signature", "shop", "timestamp", "logged_in_customer_id"]) {
    if (params.getAll(key).length > 1) return false;
  }
  if (!SHOP_DOMAIN.test(params.get("shop") ?? "")) return false;
  if (!/^\d*$/.test(params.get("logged_in_customer_id") ?? "")) return false;
  if (!isFresh(params, options)) return false;

  // repeated keys are signed once, with their values joined by commas: extra=1&extra=2 -> extra=1,2
  const grouped = new Map<string, string[]>();
  for (const [key, value] of params) {
    if (key === "signature") continue;
    if (key.includes("=")) return false;
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  // Shopify's documented example sorts the whole key=value strings and joins them with nothing
  const message = [...grouped].map(([key, values]) => `${key}=${values.join(",")}`).sort(compareCodeUnits).join("");

  // With no separator, a caller who has one signed URL can fold Shopify's own `shop=` or
  // `logged_in_customer_id=` pair into a neighbouring parameter and present a second one as real.
  // That always leaves the name in the signed string twice, so require it exactly once.
  for (const key of ["shop", "logged_in_customer_id"]) {
    if (message.split(`${key}=`).length - 1 !== (params.has(key) ? 1 : 0)) return false;
  }

  return verifyHmac(secrets, hexToBytes(signature), encoder.encode(message));
}

function isFresh(params: URLSearchParams, options: QueryOptions): boolean {
  const timestamp = params.get("timestamp") ?? "";
  if (!/^\d+$/.test(timestamp)) return false;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  return Math.abs(now - Number(timestamp)) <= (options.maxAgeSeconds ?? 90);
}

export interface SessionTokenPayload {
  iss: string;
  dest: string;
  aud: string;
  sub?: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  sid?: string;
}

export interface VerifiedSessionToken {
  /** the store's permanent domain, such as `example.myshopify.com` */
  shop: string;
  payload: SessionTokenPayload;
}

/**
 * Verifies a session token (Shopify also calls it an ID token): the JWT App Bridge sends from an
 * embedded app, usually as `Authorization: Bearer <token>` or as the `id_token` query parameter
 * on the first load. Returns null when the token is invalid.
 */
export async function verifySessionToken(
  token: string,
  options: { clientId: string; secrets: Secrets; nowSeconds?: number; leewaySeconds?: number }
): Promise<VerifiedSessionToken | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  const header = parseJsonSegment(encodedHeader);
  if (!header || header.alg !== "HS256") return null;

  const signature = base64ToBytes(encodedSignature);
  if (!signature || signature.length !== 32) return null;
  if (!(await verifyHmac(options.secrets, signature, encoder.encode(`${encodedHeader}.${encodedPayload}`)))) return null;

  const payload = parseJsonSegment(encodedPayload) as SessionTokenPayload | null;
  if (!payload) return null;

  // Shopify documents no clock skew allowance; 10 seconds is what Shopify's own library allows
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const leeway = options.leewaySeconds ?? 10;
  if (typeof payload.exp !== "number" || payload.exp <= now - leeway) return null;
  if (typeof payload.nbf !== "number" || payload.nbf > now + leeway) return null;
  if (payload.aud !== options.clientId) return null;

  const shop = hostname(payload.dest);
  if (!shop || shop !== hostname(payload.iss) || !SHOP_DOMAIN.test(shop)) return null;

  return { shop, payload };
}

async function verifyHmac(secrets: Secrets, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  // an empty secret (an unset environment variable) fails the check instead of throwing a 500
  for (const secret of (typeof secrets === "string" ? [secrets] : secrets).filter(Boolean)) {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    // crypto.subtle.verify compares in constant time, so the check leaks no timing information
    if (await crypto.subtle.verify("HMAC", key, signature, message)) return true;
  }
  return false;
}

// Array.prototype.sort's default order: compares UTF-16 code units, like Ruby's and Python's sort on ASCII keys
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// accepts standard and URL-safe base64, with or without padding
function base64ToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function parseJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64ToBytes(segment);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function hostname(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
