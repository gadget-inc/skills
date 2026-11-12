// The same app as railway-bad/.railway/railway.ts, done right. Its cron service is added at the cutover.
import { defineRailway, github, postgres, project, redis, ref, service } from "railway/iac";

export default defineRailway((ctx) => {
  const region = "us-east4-eqdc4a";
  const db = postgres("postgres", { region });
  const queue = redis("redis", { region });

  const env = {
    DATABASE_URL: "postgresql://app_user:${{shared.APP_DB_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgres.PGDATABASE}}",
    DIRECT_DATABASE_URL: ref(db, "DATABASE_UNPOOLED_URL"),
    REDIS_URL: queue.env.REDIS_URL,
    SHOPIFY_APP_URL: "https://${{web.RAILWAY_PUBLIC_DOMAIN}}",
    APP_ENV: ctx.environment ?? "development",
  };

  const web = service("web", {
    source: github("my-org/my-app"),
    start: "npm run start",
    preDeploy: "npx prisma migrate deploy",
    healthcheck: "/healthz",
    domains: [{ domain: "app.example.com", port: 3000 }],
    deploy: { drainingSeconds: 30 },
    env: { ...env, PORT: "3000" },
  });

  const worker = service("worker", {
    source: github("my-org/my-app"),
    start: "node build/worker.js",
    deploy: { drainingSeconds: 900 },
    env,
  });

  const admin = service("admin", {
    source: github("my-org/my-app"),
    start: "npm run start",
    deploy: { drainingSeconds: 30 },
    env,
  });

  return project("my-app", { resources: [db, queue, web, worker, admin] });
});
