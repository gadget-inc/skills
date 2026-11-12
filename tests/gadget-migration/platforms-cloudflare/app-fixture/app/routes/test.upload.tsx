// test only: signs an upload URL inside the Workers runtime with the reference's helper
import { createUpload } from "../services/files.server";

export const loader = async () => Response.json(await createUpload("7", "42", { name: "guide.pdf", type: "application/pdf", size: 1234 }));
