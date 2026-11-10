// Checks for apps that receive Shopify webhooks through Hookdeck. references/platforms/hookdeck.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { lineAt, lineOf } from "./read-config.ts";
import { calls, mask } from "./source-scan.ts";

const GUIDE = `${DOCS}/hookdeck`;
const TOML = /(^|\/)shopify\.app(\.[\w-]+)?\.toml$/;
// where setup commands and rule JSON live: scripts, CI, and rule files, not docs
const SETUP = /(^|\/)(package\.json|Makefile|Dockerfile[\w.-]*|[\w.-]+\.(sh|json|ya?ml|ts|js|mjs))$/;

const hasHookdeckToml = (repo: Repo) => repo.find(TOML).some((f) => /hkdk\.events/.test(repo.read(f) ?? ""));

// Each `hookdeck ...` command, with backslash-continued lines joined, and the index it starts at.
function commands(text: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  for (const m of text.matchAll(/hookdeck\s+(?:gateway\s+)?connection\s+(?:upsert|create|update)\b(?:[^\n]*\\\n)*[^\n]*/g)) out.push({ text: m[0], index: m.index! });
  return out;
}

function setupFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  for (const file of repo.find(SETUP).filter((f) => !f.includes("node_modules") && !/(^|\/)package-lock\.json$/.test(f))) {
    const text = repo.read(file) ?? "";
    if (!/hookdeck|hkdk|"deduplicate"|x-shopify-shop-domain/i.test(text)) continue;
    const at = (index: number) => lineAt(text, index);
    for (const m of text.matchAll(/--source-webhook-secret\b/g)) {
      findings.push({
        id: "hookdeck/source-webhook-secret",
        severity: "error",
        file,
        line: at(m.index!),
        message: "--source-webhook-secret sets up a hex check on an x-webhook-signature header for every source type except Stripe. Shopify never sends that header, so a Shopify source configured this way rejects every webhook, or the API refuses the config.",
        error: "VERIFICATION_FAILED",
        fix: 'Pass the client secret as --source-config "{\\"auth\\":{\\"webhook_secret_key\\":\\"$SHOPIFY_API_SECRET\\"}}" with --source-type SHOPIFY.',
        docs: `${GUIDE}#create-the-connection`,
      });
    }
    for (const cmd of commands(text)) {
      if (/--rule-filter-(headers|body|path|query)\b/.test(cmd.text) && !/--rule-retry-strategy\b/.test(cmd.text) && /\b(upsert|update)\b/.test(cmd.text)) {
        findings.push({
          id: "hookdeck/filter-replaces-rules",
          severity: "error",
          file,
          line: at(cmd.index),
          message: "This updates the connection with a filter flag and no retry flag. The CLI sends the filter as the whole rules array, which replaces the connection's retry and deduplicate rules, so failed deliveries stop retrying without an error.",
          fix: "Send every rule each time: the filter, the retry rule, and the deduplicate rule, such as with scripts/hookdeck.ts filters from references/platforms/hookdeck.md.",
          docs: `${GUIDE}#move-one-store-at-a-time`,
        });
      }
    }
    for (const m of text.matchAll(/--rule-deduplicate-window[\s=]+["']?(\d+)/g)) {
      if (Number(m[1]) > 3600) continue;
      findings.push(dedupeFinding(file, at(m.index!), m[1]));
    }
    for (const m of text.matchAll(/["']?type["']?\s*:\s*["']deduplicate["'][^}]*?["']?window["']?\s*:\s*(\d+)|["']?window["']?\s*:\s*(\d+)[^}]*?["']?type["']?\s*:\s*["']deduplicate["']/g)) {
      const value = m[1] ?? m[2];
      if (Number(value) > 3600) continue;
      findings.push(dedupeFinding(file, at(m.index!), value));
    }
    for (const m of text.matchAll(/(?:response_status_codes["']?\s*:\s*\[([^\]]*)\]|--rule-retry-response-status-codes[\s=]+["']?([^\s"']+))/g)) {
      const codes = (m[1] ?? m[2]).split(",").map((c) => c.replace(/["'\s]/g, "")).filter(Boolean);
      if (!codes.length || !codes.every((c) => /^(5\d\d|5\d\d-5\d\d|>=?5\d\d|>499)$/.test(c))) continue;
      findings.push({
        id: "hookdeck/retry-5xx-only",
        severity: "warning",
        file,
        line: at(m.index!),
        message: `The retry rule only retries ${codes.join(", ")}. A webhook that reaches the wrong path gets a 404 from your app, and it is never retried after you fix the path.`,
        fix: "Leave response_status_codes out, so Hookdeck retries every response outside the 200 range, timeouts, and network errors.",
        docs: `${GUIDE}#create-the-connection`,
      });
    }
    if (/shopify/i.test(text)) {
      for (const m of text.matchAll(/["']?type["']?\s*:\s*["']transform["']|--rule-transform-(name|code)\b/g)) {
        findings.push({
          id: "hookdeck/transform-rule",
          severity: "error",
          file,
          line: at(m.index!),
          message: "A transformation on a connection that carries Shopify webhooks changes the body after Shopify signed it, so your app's HMAC check rejects every delivery. Even a whitespace change breaks it.",
          error: "401 from authenticate.webhook",
          fix: "Remove the transform rule from Shopify connections. Change the payload in your app after the HMAC check.",
          docs: `${GUIDE}#verify-requests-in-your-app`,
        });
      }
    }
    // shop filters: a plain array means "contains all", and $in, $startsWith, and $endsWith match substrings
    for (const m of text.matchAll(/["']?x-shopify-shop-domain["']?\s*:\s*(\[|\{\s*["']?\$(in|startsWith|endsWith)\b)/g)) {
      findings.push({
        id: "hookdeck/filter-syntax",
        severity: "error",
        file,
        line: at(m.index!),
        message: m[2]
          ? `$${m[2]} matches part of a string, so a filter for store-a.myshopify.com also lets through my-store-a.myshopify.com.`
          : "A plain array in a Hookdeck filter means the value must contain every element. A header is one string, so this filter matches no store and every webhook is ignored.",
        fix: 'Match exact domains with $or, as in { "x-shopify-shop-domain": { "$or": ["my-test-store.myshopify.com"] } }.',
        docs: `${GUIDE}#move-one-store-at-a-time`,
      });
    }
    for (const m of text.matchAll(/x-shopify-shop-domain[^\n]*?["'][a-z0-9-]+\.myshopify\.com["']/g)) {
      findings.push({
        id: "hookdeck/hand-written-filter",
        severity: "warning",
        file,
        line: at(m.index!),
        message: "This writes a shop filter with the store domains in the file. Filters written by hand on the new app's connection and on Gadget's drift apart, and a store in neither list loses its webhooks.",
        fix: "Keep the moved stores in one table and write every connection's filter from it, as scripts/hookdeck.ts filters in references/platforms/hookdeck.md does.",
        docs: `${GUIDE}#move-one-store-at-a-time`,
      });
    }
  }
  return findings;
}

function dedupeFinding(file: string, line: number, value: string): Finding {
  return {
    id: "hookdeck/dedupe-window-seconds",
    severity: "error",
    file,
    line,
    message: `The deduplicate window is ${value}, which Hookdeck reads as milliseconds: ${Number(value) / 1000} seconds. The CLI's --rule-deduplicate-window help says seconds, but it passes the number to the API unchanged.`,
    fix: "Use 3600000 for the 1-hour maximum, in a --rules JSON array.",
    docs: `${GUIDE}#create-the-connection`,
  };
}

interface SourceUri {
  file: string;
  line: number;
  uri: string;
  // the path after the source id, such as "/webhooks/orders/updated", or ""
  path: string;
  placeholder: boolean;
}

// Every hkdk.events URI in a shopify.app*.toml.
function sourceUris(repo: Repo): SourceUri[] {
  const out: SourceUri[] = [];
  for (const file of repo.find(TOML)) {
    const text = repo.read(file) ?? "";
    for (const m of text.matchAll(/uri\s*=\s*"(https:\/\/hkdk\.events\/[^"]*)"/g)) {
      const [source, ...path] = m[1].slice("https://hkdk.events/".length).split("/");
      const rest = path.join("/").replace(/\/+$/, "");
      out.push({ file, line: lineAt(text, m.index!), uri: m[1], path: rest ? `/${rest}` : "", placeholder: /[<>{}]/.test(source) || /source[-_]?id/i.test(source) });
    }
  }
  return out;
}

interface Destination {
  file: string;
  line: number;
  url: string;
  // the URL's path, or "" for an origin
  path: string;
  // false when the command turns path forwarding off, so the URL gets every webhook as it is
  forwarding: boolean;
}

// Every --destination-url in a `hookdeck connection` command in the setup files.
function destinations(repo: Repo): Destination[] {
  const out: Destination[] = [];
  for (const file of repo.find(SETUP).filter((f) => !f.includes("node_modules") && !/(^|\/)package-lock\.json$/.test(f))) {
    const text = repo.read(file) ?? "";
    if (!/hookdeck/i.test(text)) continue;
    for (const cmd of commands(text)) {
      const url = /--destination-url[\s=]+["']?(https?:\/\/[^\s"'\\]+)/.exec(cmd.text);
      if (!url) continue;
      let path = "";
      try {
        path = new URL(url[1]).pathname.replace(/\/+$/, "");
      } catch {
        continue;
      }
      out.push({ file, line: lineAt(text, cmd.index + url.index), url: url[1], path, forwarding: !/--destination-path-forwarding-disabled[\s=]+["']?true/.test(cmd.text) });
    }
  }
  return out;
}

// Route files that receive webhooks, such as app/routes/webhooks.orders.updated.tsx or app/api/webhooks/route.ts.
const webhookRoutes = (repo: Repo) => repo.sourceFiles().filter((f) => /(^|\/)(routes|pages|api)\/(.*\/)?[^/]*webhook/i.test(f));

// Hookdeck delivers to the destination URL followed by whatever path came after the source id in the URI
// Shopify called. So the path belongs in exactly one of the two: in each toml URI, with an origin as the
// destination, or, for an app with one route that handles every topic, in the destination URL alone.
function pathFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  const uris = sourceUris(repo);
  const dests = destinations(repo);
  const forwarded = dests.filter((d) => d.forwarding);
  const routed = uris.filter((u) => u.path);
  const routes = webhookRoutes(repo);

  for (const d of forwarded.filter((x) => x.path)) {
    // every URI is the bare source URL, so the destination's path is the only one: one route takes every topic
    if (uris.length && !routed.length) continue;
    const doubled = `${d.path}${routed[0]?.path ?? d.path}`;
    findings.push({
      id: "hookdeck/destination-path",
      severity: routed.length ? "error" : "warning",
      file: d.file,
      line: d.line,
      message: routed.length
        ? `The destination URL has the path ${d.path}, and ${routed[0].uri} in ${routed[0].file} has a path too. Hookdeck appends the path after the source id to the destination URL, so that webhook arrives at ${doubled} and your app answers 404.`
        : `The destination URL has the path ${d.path}, and no shopify.app*.toml here shows the subscription URIs. If they carry a path after the source id too, Hookdeck appends it to the destination URL, and a webhook arrives at ${doubled}.`,
      error: `404 for ${doubled}`,
      fix: "Keep the path in one place: give the destination only your app's origin, such as https://app.example.com, with the path in each uri in shopify.app.toml, or, for one route that handles every topic, the bare source URL as every uri.",
      docs: `${GUIDE}#point-shopify-at-hookdeck`,
    });
  }

  for (const u of uris) {
    const fix = "Use your source's URL followed by the path your app serves the topic on, such as https://hkdk.events/src_abc123/webhooks/orders/updated, with only your app's origin as the destination URL.";
    if (u.placeholder) {
      findings.push({
        id: "hookdeck/toml-uri",
        severity: "error",
        file: u.file,
        line: u.line,
        message: `${u.uri} still has a placeholder where the Hookdeck source id goes, so Shopify delivers to a source that doesn't exist.`,
        fix,
        docs: `${GUIDE}#point-shopify-at-hookdeck`,
      });
      continue;
    }
    if (u.path) continue;
    // path forwarding is off everywhere, so the destination URL alone decides where webhooks go
    if (dests.length && !forwarded.length) continue;
    // a single endpoint: the destination URL carries the path of the route that takes every topic
    if (!routed.length && forwarded.some((d) => d.path)) continue;
    const destination = forwarded[0];
    let severity: "error" | "warning";
    let message: string;
    if (routed.length) {
      severity = "error";
      message = `${u.uri} has no path after the source id while ${routed[0].uri} has one, so Hookdeck delivers this topic to the destination URL itself, not to the route that handles it.`;
    } else if (destination) {
      severity = routes.length ? "error" : "warning";
      message = `${u.uri} has no path after the source id, and the destination URL ${destination.url} (${destination.file}) has none either, so Hookdeck delivers this topic to your app's origin, not to the route that handles it.`;
    } else {
      severity = routes.length > 1 ? "error" : "warning";
      message =
        routes.length > 1
          ? `${u.uri} has no path after the source id, and the app has ${routes.length} webhook routes. Hookdeck delivers each topic to the destination URL followed by that path, so with none every topic reaches the same URL and at most one of the routes gets webhooks.`
          : `${u.uri} has no path after the source id, so Hookdeck delivers this topic to the destination URL as it is. That works only if the destination URL, which isn't in this repository, ends with the path of a route that handles every topic.`;
    }
    findings.push({ id: "hookdeck/toml-uri", severity, file: u.file, line: u.line, message, fix, docs: `${GUIDE}#point-shopify-at-hookdeck` });
  }
  return findings;
}

function routeFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  const behindHookdeck = hasHookdeckToml(repo);
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    // match calls in code only: "never call request.json() before authenticate.webhook" in a comment isn't one
    const code = mask(text);
    const auth = /authenticate\.webhook\s*\(|verifyWebhook\s*\(|webhooks\.validate\s*\(/.exec(code);
    if (!auth) continue;
    // the body read or rewritten before the HMAC check
    const early = [...calls(text, "\\brequest\\.(?:json|formData)")].find((c) => c.index < auth.index);
    const restring = /(?:verifyWebhook|validate)\s*\([^)]*JSON\.stringify\s*\(/.exec(code);
    if (early || restring) {
      findings.push({
        id: "hookdeck/body-before-hmac",
        severity: "error",
        file,
        line: lineAt(text, (early?.index ?? restring!.index)),
        message: early
          ? "This route parses the request body before Shopify's HMAC check. The check needs the exact bytes, and a body that was already read can't be read again."
          : "This checks Shopify's HMAC against JSON.stringify of the parsed body. The signature covers the exact bytes Shopify sent, which re-serializing changes.",
        error: early ? "TypeError: Body is unusable: Body has already been read" : "401 for every delivery",
        fix: "Run authenticate.webhook(request) or verifyWebhook on the raw body first, and use the payload it returns. Read a copy with request.clone() for any other check.",
        docs: `${GUIDE}#verify-requests-in-your-app`,
      });
    }
    if (!behindHookdeck || !/authenticate\.webhook\s*\(/.test(code)) continue;
    const imports = [...text.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((m) => new URL(m[1], `file:///${file}`).pathname.slice(1));
    const checked = [text, ...imports.flatMap((base) => [base, `${base}.ts`, `${base}.tsx`, `${base}.js`].map((f) => repo.read(f) ?? ""))].some((t) => /x-hookdeck-signature/.test(t));
    if (checked) continue;
    findings.push({
      id: "hookdeck/no-hookdeck-signature",
      severity: "warning",
      file,
      line: lineAt(text, auth.index),
      message: "This webhook route doesn't check Hookdeck's x-hookdeck-signature. Anyone who sends a request Shopify signed, such as a replay of an old delivery, reaches the route without Hookdeck's deduplication or rate limits.",
      fix: "Check x-hookdeck-signature, and x-hookdeck-signature-2 during a secret roll, against HOOKDECK_WEBHOOK_SECRET before authenticate.webhook.",
      docs: `${GUIDE}#verify-requests-in-your-app`,
    });
  }
  return findings;
}

function processedWebhookFindings(repo: Repo): Finding[] {
  if (!hasHookdeckToml(repo)) return [];
  const toml = repo.find(TOML).find((f) => /hkdk\.events/.test(repo.read(f) ?? ""))!;
  const schemaFiles = [...repo.find(/\.sql$/), ...repo.find(/(^|\/)schema\.prisma$/)];
  const table = schemaFiles.find((f) => /processed_webhook|webhook_?id\b[^\n]*(primary key|@id|@unique)|@@map\("processed_webhook"\)/i.test(repo.read(f) ?? ""));
  if (!table) {
    return [
      {
        id: "hookdeck/processed-webhook",
        severity: "warning",
        file: toml,
        line: lineOf(repo.read(toml) ?? "", "hkdk.events"),
        message: "Shopify webhooks reach this app through Hookdeck, and nothing records which webhook ids the app processed. Hookdeck retries a delivery whose response it never got and deduplicates for 1 hour at most, so side effects such as a notification run twice.",
        fix: "Create a processed_webhook table keyed on X-Shopify-Webhook-Id and insert the id in the same transaction as the work, as references/shopify-webhooks.md shows.",
        docs: `${GUIDE}#process-webhooks-before-responding`,
      },
    ];
  }
  const all = [...repo.sourceFiles(), ...repo.find(/\.sql$/)];
  const cleaned = all.some((f) => /delete\s+from\s+processed_webhook|processedWebhook\.deleteMany/i.test(repo.read(f) ?? ""));
  if (cleaned) return [];
  return [
    {
      id: "hookdeck/processed-webhook",
      severity: "warning",
      file: table,
      line: lineOf(repo.read(table) ?? "", /processed_webhook|webhook_?id/i),
      message: "Nothing deletes old processed_webhook rows, so the table grows by one row per webhook forever.",
      fix: "Delete rows older than your Hookdeck plan's retention plus a day, in batches, on a daily schedule, as the cleanup job in references/platforms/hookdeck.md does.",
      docs: `${GUIDE}#process-webhooks-before-responding`,
    },
  ];
}

function manualFindings(repo: Repo): Finding[] {
  const toml = repo.find(TOML).find((f) => /hkdk\.events/.test(repo.read(f) ?? ""));
  return [
    {
      id: "hookdeck/connection-audit",
      severity: "manual",
      file: toml,
      line: toml ? lineOf(repo.read(toml) ?? "", "hkdk.events") : undefined,
      message: "The source type and secret, the rules, the destination's URL, auth, and delivery policy, and whether a connection is paused live in Hookdeck, not in this repository.",
      fix: "Run HOOKDECK_API_KEY=... node scripts/hookdeck.ts audit from references/platforms/hookdeck.md, and hookdeck gateway request list --rejection-cause VERIFICATION_FAILED after the first webhook.",
      docs: `${GUIDE}#create-the-connection`,
    },
  ];
}

export const hookdeck: CheckModule = {
  platform: "hookdeck",
  title: "Hookdeck",
  detect: (repo) =>
    repo.sourceFiles().some((f) => /x-hookdeck-signature|api\.hookdeck\.com/.test(repo.read(f) ?? "")) ||
    hasHookdeckToml(repo) ||
    repo.find(/(^|\/)(package\.json|[\w.-]+\.sh)$/).some((f) => /hookdeck\s+gateway/.test(repo.read(f) ?? "")),
  run: (repo) => [...setupFindings(repo), ...pathFindings(repo), ...routeFindings(repo), ...processedWebhookFindings(repo), ...manualFindings(repo)],
};
