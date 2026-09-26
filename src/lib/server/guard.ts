import "server-only";

// CSRF guard for state-changing routes: only accept requests from our own
// origin (the session cookie is also SameSite=Lax).
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === new URL(req.url).origin;
  // Some same-origin requests omit Origin; fall back to Fetch Metadata.
  return req.headers.get("sec-fetch-site") === "same-origin";
}

export const forbidden = () => Response.json({ error: "Forbidden" }, { status: 403 });
