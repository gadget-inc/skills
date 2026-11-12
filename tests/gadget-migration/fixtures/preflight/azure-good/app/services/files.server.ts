import { DefaultAzureCredential } from "@azure/identity";
import { BlobSASPermissions, BlobServiceClient, generateBlobSASQueryParameters, SASProtocol } from "@azure/storage-blob";

const account = process.env.STORAGE_ACCOUNT!;
const credential = new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID });
const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential);
const container = service.getContainerClient("files");

async function signedUrl(key: string, permissions: string, expiresOn: Date) {
  const startsOn = new Date(Date.now() - 5 * 60 * 1000);
  // signs with the managed identity, and a user delegation key lasts at most 7 days
  const delegationKey = await service.getUserDelegationKey(startsOn, expiresOn);
  const sas = generateBlobSASQueryParameters(
    {
      containerName: "files",
      blobName: key,
      permissions: BlobSASPermissions.parse(permissions),
      startsOn,
      expiresOn,
      protocol: SASProtocol.Https,
    },
    delegationKey,
    account
  );
  return `${container.getBlockBlobClient(key).url}?${sas}`;
}

// a link to a private file that works for 3 hours, like Gadget's private file URLs
export const privateFileUrl = (key: string) => signedUrl(key, "r", new Date(Date.now() + 3 * 60 * 60 * 1000));

// the browser sends the file to this URL with a PUT request and an x-ms-blob-type: BlockBlob header
export const uploadUrl = (key: string) => signedUrl(key, "cw", new Date(Date.now() + 15 * 60 * 1000));
