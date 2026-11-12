import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ endpoint: process.env.ENDPOINT, region: process.env.REGION });

// signed on every request by the /files route, so it only has to outlast the redirect
export function publicFileUrl(key: string) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.BUCKET, Key: key }), {
    expiresIn: 60 * 60,
  });
}
