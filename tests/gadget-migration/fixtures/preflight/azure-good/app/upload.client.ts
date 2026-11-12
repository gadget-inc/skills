// in app/upload.client.ts
// The browser's half: ask the app for a signed URL, then send the file straight to Blob Storage.
export async function uploadFile(file: File): Promise<string> {
  const signed = await fetch("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name }),
  });
  if (!signed.ok) throw new Error(`signing the upload failed with ${signed.status}`);
  const { key, url } = (await signed.json()) as { key: string; url: string };
  const response = await fetch(url, {
    method: "PUT",
    // Put Blob answers 400 without x-ms-blob-type, and the account's CORS rule has to allow the header
    headers: { "x-ms-blob-type": "BlockBlob", "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!response.ok) throw new Error(`the upload failed with ${response.status}: ${await response.text()}`);
  return key;
}
