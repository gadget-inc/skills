import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});

// 3 hours, like Gadget's private file URLs
export async function privateFileUrl(key: string) {
  return await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.FILES_BUCKET!, Key: key }), {
    expiresIn: 3 * 60 * 60,
  });
}
