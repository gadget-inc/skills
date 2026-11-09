// Verifies the `signed_payload_jwt` BigCommerce sends to a single-click app's load, uninstall, and
// remove-user callbacks. Web Crypto only, so it runs on Node 20+, Bun, Deno, and edge runtimes.
//
// BigCommerce signs the token with HS256 and the app's client secret. A verified token proves the
// request came from BigCommerce for this app, and names the store and the user.

export type BigCommerceSignedPayload = {
  aud: string; // the app's client id
  iss: string; // always "bc"
  sub: string; // "stores/<store hash>"
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  user: { id: number; email: string; locale?: string };
  owner: { id: number; email: string };
  url: string; // deep link path inside the app, "/" by default
  channel_id: number | null;
};

export type VerifiedBigCommercePayload = BigCommerceSignedPayload & { storeHash: string };

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Returns the claims when the token is genuine, current, and addressed to this app. Returns null
 * otherwise. `clockToleranceSeconds` allows for clock drift between BigCommerce and your server.
 */
export async function verifyBigCommerceSignedPayload(
  token: string | null | undefined,
  clientId: string,
  clientSecret: string,
  { now = Date.now(), clockToleranceSeconds = 5 }: { now?: number; clockToleranceSeconds?: number } = {}
): Promise<VerifiedBigCommercePayload | null> {
  if (!token || !clientSecret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header: { alg?: string };
  let payload: BigCommerceSignedPayload;
  let signature: Uint8Array;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedHeader)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload)));
    signature = base64UrlToBytes(encodedSignature);
  } catch {
    return null;
  }

  // Accept HS256 only. A token that names its own algorithm, such as "none", is rejected here.
  if (header.alg !== "HS256") return null;

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(clientSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  // crypto.subtle.verify compares in constant time
  const genuine = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
  if (!genuine) return null;

  const seconds = Math.floor(now / 1000);
  if (payload.iss !== "bc" || payload.aud !== clientId) return null;
  if (typeof payload.exp !== "number" || seconds > payload.exp + clockToleranceSeconds) return null;
  if (typeof payload.nbf === "number" && seconds < payload.nbf - clockToleranceSeconds) return null;

  const storeHash = /^stores\/([a-z0-9]+)$/i.exec(payload.sub ?? "")?.[1];
  if (!storeHash) return null;
  return { ...payload, storeHash };
}
