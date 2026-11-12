import { KVSessionStorage } from "@shopify/shopify-app-session-storage-kv";
import { env } from "cloudflare:workers";

export const kvSessionStorage = () => new KVSessionStorage(env.SESSIONS);
