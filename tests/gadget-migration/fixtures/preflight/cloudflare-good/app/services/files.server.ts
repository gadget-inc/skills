// public files are served from a custom domain connected to the bucket
export const publicFileUrl = (key: string) => `https://files.example.com/${key}`;
