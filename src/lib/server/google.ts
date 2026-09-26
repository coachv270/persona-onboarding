import "server-only";
import { clearSession, readSession, writeSession, type GmailSession } from "./session";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export class NotConnected extends Error {}
export class ReconnectNeeded extends Error {}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  error?: string;
}

function clientCredentials() {
  const id = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Google OAuth client is not configured");
  return { client_id: id, client_secret: secret };
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...clientCredentials(), ...params }),
  });
  const body = (await res.json()) as TokenResponse & { error_description?: string };
  if (!res.ok) throw Object.assign(new Error(body.error_description ?? body.error ?? `Google ${res.status}`), { code: body.error });
  return body;
}

// Popup code flow: the browser only ever sees a one-time code.
export async function exchangeCode(code: string) {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: "postmessage" });
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    scopes: t.scope.split(" "),
  };
}

// A usable access token for this request, refreshing (and re-sealing the
// cookie) when it's about to expire.
export async function getAccessToken(log: string[]): Promise<{ token: string; session: GmailSession }> {
  const session = await readSession();
  if (!session) throw new NotConnected();
  if (session.accessToken && (session.expiresAt ?? 0) > Date.now() + 60_000) {
    return { token: session.accessToken, session };
  }
  try {
    const t = await tokenRequest({ refresh_token: session.refreshToken, grant_type: "refresh_token" });
    const next = { ...session, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    await writeSession(next);
    log.push("access token refreshed");
    return { token: t.access_token, session: next };
  } catch (e) {
    // invalid_grant: revoked, or a Testing-mode refresh token past 7 days.
    if ((e as { code?: string }).code === "invalid_grant") {
      await clearSession();
      log.push("refresh token rejected, session cleared");
      throw new ReconnectNeeded();
    }
    throw e;
  }
}

export async function revoke(token: string) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
}
