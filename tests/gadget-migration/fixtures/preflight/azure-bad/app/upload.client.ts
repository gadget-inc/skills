export async function uploadFile(file: File, url: string) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": file.type },
    body: file,
  });
  if (!response.ok) throw new Error(`upload failed: ${response.status}`);
}
