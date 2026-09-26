import { readSession } from "@/lib/server/session";
import type { GmailStatus } from "@/lib/mailTypes";

// What the browser may know about the connection: never a token.
export async function GET() {
  const s = await readSession();
  const status: GmailStatus = s
    ? { connected: true, email: s.email, scopes: s.scopes, accessExpiresAt: s.expiresAt }
    : { connected: false };
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}
