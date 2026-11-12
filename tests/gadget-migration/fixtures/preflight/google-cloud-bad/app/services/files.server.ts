import { Storage } from "@google-cloud/storage";

const bucket = new Storage().bucket(process.env.FILES_BUCKET!);

export async function privateFileUrl(key: string) {
  const [url] = await bucket.file(key).getSignedUrl({ version: "v4", action: "read", expires: Date.now() + 3 * 60 * 60 * 1000 });
  return url;
}
