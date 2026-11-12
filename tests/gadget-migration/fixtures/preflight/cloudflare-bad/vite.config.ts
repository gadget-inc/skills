import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

// the template's workaround: the Shopify CLI passes the tunnel URL as HOST
if (process.env.HOST && !process.env.SHOPIFY_APP_URL) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
}

export default defineConfig({ plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter()] });
