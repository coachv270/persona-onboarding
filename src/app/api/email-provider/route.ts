import { resolveMx } from "node:dns/promises";
import { normalizeEmail, type EmailProvider } from "@/lib/onboarding";

// Is this address a Google account? gmail.com is obvious, but Google Workspace
// uses custom domains, so check where the domain's mail is hosted (MX records).

const GOOGLE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const MICROSOFT_DOMAINS = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);
const OTHER_DOMAINS = new Set(["yahoo.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com"]);

async function detect(domain: string): Promise<EmailProvider> {
  if (GOOGLE_DOMAINS.has(domain)) return "google";
  if (MICROSOFT_DOMAINS.has(domain)) return "microsoft";
  if (OTHER_DOMAINS.has(domain)) return "other";
  try {
    const hosts = (await resolveMx(domain)).map((r) => r.exchange.toLowerCase());
    if (!hosts.length) return "unknown";
    if (hosts.some((h) => h.endsWith(".google.com") || h.endsWith(".googlemail.com"))) return "google";
    if (hosts.some((h) => h.endsWith(".outlook.com"))) return "microsoft";
    return "other";
  } catch {
    return "unknown";
  }
}

export async function GET(req: Request) {
  if (req.headers.get("sec-fetch-site") !== "same-origin") return Response.json({ error: "Forbidden" }, { status: 403 });
  const email = normalizeEmail(new URL(req.url).searchParams.get("email") ?? "");
  if (!email) return Response.json({ error: "Invalid email" }, { status: 400 });
  const provider = await detect(email.split("@")[1]);
  return Response.json({ provider }, { headers: { "Cache-Control": "private, max-age=3600" } });
}
