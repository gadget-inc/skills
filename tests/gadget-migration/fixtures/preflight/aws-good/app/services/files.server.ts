import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});

// signed when a page shows the file, because the task role's credentials rotate
export async function privateFileUrl(key: string) {
  return await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.FILES_BUCKET!, Key: key }), {
    expiresIn: 15 * 60,
  });
}
