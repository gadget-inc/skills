// Every pitfall the Railway checks look for. railway-good/.railway/railway.ts is the same app done right.
import { defineRailway, github, postgres, project, service } from "railway/iac";

export default defineRailway((ctx) => {
  const region = "us-east4-eqdc4a";
  const db = postgres("postgres", { region });

  const env = {
    DATABASE_URL: db.env.DATABASE_URL,
    DIRECT_DATABASE_URL: db.env.DATABASE_URL,
    REPORTING_DATABASE_URL: "postgresql://reporting:${{shared.REPORTING_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgres.PGDATABASE}}",
    REDIS_URL: "${{Redis.REDIS_URL}}",
    SHOPIFY_APP_URL: "${{web.RAILWAY_PUBLIC_DOMAIN}}",
    APP_ENV: ctx.environment ?? "development",
  };

  const web = service("web", {
    source: github("my-org/my-app"),
    start: "npm run start",
    domains: ["app.example.com"],
    deploy: { sleepApplication: true },
    env,
  });

  const worker = service("worker", {
    source: github("my-org/my-app"),
    start: "pnpm run worker",
    env,
  });

  const admin = service("admin", {
    source: github("my-org/my-app"),
    start: "npm run docker-start",
    deploy: { drainingSeconds: 30 },
    env,
  });

  const pruneAuditLogs = service("prune-audit-logs", {
    source: github("my-org/my-app"),
    start: "node build/enqueue-prune-audit-logs.js",
    deploy: { cronSchedule: "*/7 * * * *" },
    env: { REDIS_URL: "${{Redis.REDIS_URL}}" },
  });

  return project("my-app", { resources: [db, web, worker, admin, pruneAuditLogs] });
});
