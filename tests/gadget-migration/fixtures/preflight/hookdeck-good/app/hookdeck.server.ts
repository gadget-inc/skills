import { createHmac, timingSafeEqual } from "node:crypto";

export function hasHookdeckSignature(request: Request, rawBody: string) {
  const expected = createHmac("sha256", process.env.HOOKDECK_WEBHOOK_SECRET!).update(rawBody).digest();
  return ["x-hookdeck-signature", "x-hookdeck-signature-2"].some((header) => {
    const signature = Buffer.from(request.headers.get(header) ?? "", "base64");
    return signature.length === expected.length && timingSafeEqual(signature, expected);
  });
}
