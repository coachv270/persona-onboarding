import { generateText, Output } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { GEMINI_MODEL } from "@/lib/tools";
import type { MailSummary } from "@/lib/gmail";

// Turns recent email headers into a few concrete "I could help with…" ideas —
// the moment onboarding proves its value.
export async function POST(req: Request) {
  const { messages, helpNeed }: { messages: MailSummary["messages"]; helpNeed: string | null } = await req.json();
  if (!messages?.length) return Response.json({ insights: [] });

  const { output } = await generateText({
    model: google(GEMINI_MODEL),
    instructions:
      "You are a personal assistant looking at a user's recent inbox (senders and subjects only). " +
      "Suggest up to 3 specific, helpful things you could do for them, each under 15 words, " +
      "referencing real senders/topics (e.g. 'Reply to Dana about Thursday's venue quote'). " +
      "Skip newsletters, receipts and automated notifications. Never invent details.",
    prompt:
      (helpNeed ? `They said they want help with: ${helpNeed}\n\n` : "") +
      messages.map((m) => `From: ${m.from} | Subject: ${m.subject}`).join("\n"),
    output: Output.object({
      schema: z.object({ insights: z.array(z.string()).max(3) }),
    }),
  });

  return Response.json({ insights: output.insights });
}
