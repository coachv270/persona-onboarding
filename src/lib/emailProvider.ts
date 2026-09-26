import { devlog } from "./devlog";
import type { EmailProvider } from "./onboarding";

// Asks the server where an address's mail is hosted (MX lookup). Only Google
// accounts can be connected today.
export async function lookupEmailProvider(email: string): Promise<EmailProvider> {
  try {
    const res = await fetch(`/api/email-provider?email=${encodeURIComponent(email)}`);
    const { provider = "unknown" } = (await res.json()) as { provider?: EmailProvider };
    devlog("state", `Email provider for ${email.split("@")[1]}: ${provider}`);
    return provider;
  } catch {
    return "unknown";
  }
}

export const providerName = (p?: EmailProvider) => (p === "microsoft" ? "Microsoft" : "non-Google");
