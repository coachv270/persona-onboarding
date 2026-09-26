import { forbidden, sameOrigin } from "@/lib/server/guard";
import { readSession, writeSession } from "@/lib/server/session";

// Dev control: drop the cached access token so the next call exercises the
// server-side refresh. The refresh token is kept.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbidden();
  const s = await readSession();
  if (!s) return Response.json({ connected: false });
  await writeSession({ ...s, accessToken: undefined, expiresAt: 0 });
  return Response.json({ connected: true, email: s.email, scopes: s.scopes, accessExpiresAt: 0 });
}
