import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ endpoint: process.env.ENDPOINT, region: process.env.REGION });

// stored in a Shopify metafield, so it should last as long as Railway allows
export function publicFileUrl(key: string) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.RAILWAY_BUCKET_NAME, Key: key }), {
    expiresIn: 90 * 24 * 60 * 60,
  });
}
