import { revoke } from "@/lib/server/google";
import { forbidden, sameOrigin } from "@/lib/server/guard";
import { clearSession, readSession } from "@/lib/server/session";

// Revokes the grant at Google and clears the session cookie.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbidden();
  const s = await readSession();
  if (s) await revoke(s.refreshToken).catch(() => {});
  await clearSession();
  return Response.json({ connected: false });
}
