import { forbidden, sameOrigin } from "@/lib/server/guard";
import { NotConnected, ReconnectNeeded } from "@/lib/server/google";
import { inboxIdeas } from "@/lib/server/mailCommands";

// Turns recent email headers (fetched server-side with the session) into a few
// concrete "I could help with…" ideas: the moment onboarding proves its value.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbidden();
  const { helpNeed = null } = (await req.json()) as { helpNeed?: string | null };
  try {
    return Response.json(await inboxIdeas(helpNeed));
  } catch (e) {
    if (e instanceof NotConnected || e instanceof ReconnectNeeded) return Response.json({ insights: [], log: ["not connected"] });
    return Response.json({ insights: [], log: [`insights failed: ${e instanceof Error ? e.message : String(e)}`] });
  }
}
