import { forbidden, sameOrigin } from "@/lib/server/guard";
import { findEmails, prepareDraft, readEmail, saveDraft, summarizePeriod } from "@/lib/server/mailCommands";
import type { Detail, Draft, MailResult } from "@/lib/mailTypes";

export const maxDuration = 30;

// Single entry point for email commands from chat and voice (via runTool).
export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbidden();
  const { command, args = {}, detail = "text" } = (await req.json()) as {
    command: string;
    args?: Record<string, unknown>;
    detail?: Detail;
  };
  const str = (k: string) => String(args[k] ?? "").trim();

  let result: MailResult;
  switch (command) {
    case "summarizeInbox":
      result = await summarizePeriod({ after: str("after"), before: str("before") || undefined }, detail);
      break;
    case "findEmails":
      result = await findEmails({ query: str("query") }, detail);
      break;
    case "readEmail":
      result = await readEmail({ id: str("id") }, detail);
      break;
    case "showDraft":
      result = await prepareDraft({ messageId: str("messageId"), body: String(args.body ?? "") });
      break;
    case "saveDraft":
      result = await saveDraft({ draft: args.draft as Draft });
      break;
    default:
      return Response.json({ error: `Unknown command ${command}` }, { status: 400 });
  }
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
