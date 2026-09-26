import { exchangeCode } from "@/lib/server/google";
import { getProfileEmail } from "@/lib/server/gmailApi";
import { forbidden, sameOrigin } from "@/lib/server/guard";
import { readSession, writeSession } from "@/lib/server/session";
import type { GmailStatus } from "@/lib/mailTypes";

// Exchanges the popup's one-time code for tokens (client secret stays here)
// and seals them into the httpOnly session cookie. Returns no tokens.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbidden();
  const { code } = (await req.json()) as { code?: string };
  if (!code) return Response.json({ error: "Missing code" }, { status: 400 });

  try {
    const t = await exchangeCode(code);
    const existing = await readSession();
    // Incremental grants (e.g. adding compose) may not return a new refresh token.
    const refreshToken = t.refreshToken ?? existing?.refreshToken;
    if (!refreshToken) return Response.json({ error: "Google didn't return a refresh token. Disconnect and try again." }, { status: 400 });
    const email = (await getProfileEmail(t.accessToken, [])).toLowerCase();
    const scopes = [...new Set([...(existing?.scopes ?? []), ...t.scopes])];
    await writeSession({ refreshToken, accessToken: t.accessToken, expiresAt: t.expiresAt, email, scopes });
    const status: GmailStatus = { connected: true, email, scopes, accessExpiresAt: t.expiresAt };
    return Response.json(status);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Couldn't connect Gmail" }, { status: 400 });
  }
}
