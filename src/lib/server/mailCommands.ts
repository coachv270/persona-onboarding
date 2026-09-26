import "server-only";
import { generateText, Output } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { COMPOSE, type Detail, type Draft, type MailResult } from "../mailTypes";
import { GEMINI_MODEL } from "../tools";
import { getAccessToken, NotConnected, ReconnectNeeded } from "./google";
import { ALL_RECEIVED, GmailAuthError, createDraft, getMessage, searchMessages, type MailItem } from "./gmailApi";

// Email commands, run on the server with the session's Google token. Chat and
// voice both reach these through the browser's runTool() → POST /api/mail.
// Results are plain text for the LLM plus optional UI side effects.

const LOCKED =
  "Gmail isn't connected, so email help is locked. A Connect Gmail button is now showing. Offer it in one sentence (read-only, nothing is ever sent).";
const RECONNECT =
  "Google access was lost (revoked or expired). A Reconnect Gmail button is now showing. Ask them to click it, then try again.";
const VOICE_HINT = "Answer aloud in 2–3 short sentences; don't read ids or addresses.";

async function withGmail(name: string, fn: (token: string, log: string[], scopes: string[]) => Promise<MailResult>): Promise<MailResult> {
  const log: string[] = [];
  try {
    const { token, session } = await getAccessToken(log);
    const result = await fn(token, log, session.scopes);
    return { ...result, log: [...log, ...(result.log ?? [])] };
  } catch (e) {
    if (e instanceof NotConnected) return { text: LOCKED, needs: "connect", log: [`${name}: locked (not connected)`] };
    if (e instanceof ReconnectNeeded || e instanceof GmailAuthError) return { text: RECONNECT, needs: "reconnect", log };
    const message = e instanceof Error ? e.message : String(e);
    return { text: `Gmail request failed (${message}). Apologize briefly and offer to try again.`, log: [...log, `${name} failed: ${message}`] };
  }
}

function toEpoch(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function formatItems(items: MailItem[], detail: Detail): string {
  return items
    .map((m, i) => {
      const from = m.from.replace(/<[^>]+>/, "").trim() || m.from;
      const snippet = detail === "voice" ? m.snippet.slice(0, 120) : m.snippet;
      const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
      return `${i + 1}. [id ${m.id}] ${from} · ${m.subject || "(no subject)"} · ${m.date}${tags}${snippet ? `: ${snippet}` : ""}`;
    })
    .join("\n");
}

export function summarizePeriod(args: { after: string; before?: string }, detail: Detail) {
  return withGmail("summarizeInbox", async (token, log) => {
    const after = toEpoch(args.after);
    const before = args.before ? toEpoch(args.before) : null;
    if (after === null || (args.before && before === null)) {
      return { text: `Invalid date(s): after="${args.after}" before="${args.before ?? ""}". Use ISO 8601, e.g. 2026-09-25T00:00:00-07:00.` };
    }
    // All received mail, archived and read included; categories are tagged, not hidden.
    const q = `${ALL_RECEIVED} after:${after}${before ? ` before:${before}` : ""}`;
    const { items, estimate } = await searchMessages(token, q, 30, log);
    log.push(`summarizeInbox ${args.after} → ${args.before ?? "now"}: ${items.length} emails (~${estimate})`);
    if (!items.length) return { text: "No emails received in that period (searched all mail, including archived)." };
    return {
      text:
        `${items.length} emails${estimate > items.length ? ` (showing the latest ${items.length} of ~${estimate})` : ""}:\n` +
        `${formatItems(items, detail)}\n\n` +
        "Summarize for the user: group by theme, call out anything that needs a reply or action, and mention promotions/newsletters only briefly. " +
        (detail === "voice" ? VOICE_HINT : "Keep it scannable."),
    };
  });
}

export function findEmails(args: { query: string }, detail: Detail) {
  return withGmail("findEmails", async (token, log) => {
    const { items } = await searchMessages(token, args.query, 5, log);
    log.push(`findEmails "${args.query}": ${items.length} results`);
    if (!items.length) return { text: `No emails match "${args.query}". Suggest a different search.` };
    return {
      text:
        `${formatItems(items, detail)}\n\n` +
        (items.length > 1
          ? "If it's unclear which one they mean, ask. Otherwise use readEmail with the id."
          : "Use readEmail with this id to open it."),
    };
  });
}

export function readEmail(args: { id: string }, detail: Detail) {
  return withGmail("readEmail", async (token, log) => {
    const m = await getMessage(token, args.id, detail === "voice" ? 1500 : 6000, log);
    log.push(`readEmail ${args.id}: ${m.body.length} chars`);
    return {
      text:
        `From: ${m.from}\nTo: ${m.to}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body || m.snippet}\n\n` +
        (detail === "voice" ? VOICE_HINT : "Summarize or answer their question about it."),
    };
  });
}

export function prepareDraft(args: { messageId: string; body: string }) {
  return withGmail("showDraft", async (token, log) => {
    const m = await getMessage(token, args.messageId, 500, log);
    const draft: Draft = {
      id: crypto.randomUUID(),
      threadId: m.threadId,
      to: m.replyTo || m.from,
      subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      body: args.body,
      inReplyTo: m.messageId,
      references: [m.references, m.messageId].filter(Boolean).join(" "),
    };
    log.push(`showDraft for ${args.messageId}`);
    return {
      draft,
      text: "The draft is on screen. Tell them they can edit it, copy it, or save it to Gmail Drafts. It is NOT sent, so never say it was.",
    };
  });
}

// Needs the compose scope, which the browser requests only on the Save click.
export function saveDraft(args: { draft: Draft }) {
  return withGmail("saveDraft", async (token, log, scopes) => {
    if (!scopes.includes(COMPOSE)) return { text: "Drafts permission not granted yet.", needs: "compose" };
    await createDraft(token, args.draft, log);
    log.push("draft saved to Gmail Drafts (not sent)");
    return { text: "Saved to Gmail Drafts. It was NOT sent." };
  });
}

// Onboarding "value moment": recent headers → a few concrete ideas (Gemini).
export async function inboxIdeas(helpNeed: string | null): Promise<{ insights: string[]; log: string[] }> {
  const log: string[] = [];
  const { token } = await getAccessToken(log);
  const { items } = await searchMessages(token, `${ALL_RECEIVED} -category:promotions -category:social newer_than:30d`, 25, log);
  if (!items.length) return { insights: [], log };
  const { output } = await generateText({
    model: google(GEMINI_MODEL),
    instructions:
      "You are a personal assistant looking at a user's recent email (senders and subjects only). " +
      "Suggest up to 3 specific, helpful things you could do for them, each under 15 words, " +
      "referencing real senders/topics (e.g. 'Reply to Dana about Thursday's venue quote'). " +
      "Skip newsletters, receipts and automated notifications. Never invent details. No em dashes.",
    prompt:
      (helpNeed ? `They said they want help with: ${helpNeed}\n\n` : "") +
      items.map((m) => `From: ${m.from} | Subject: ${m.subject}`).join("\n"),
    output: Output.object({ schema: z.object({ insights: z.array(z.string()).max(3) }) }),
  });
  log.push(`inbox ideas: ${output.insights.length}`);
  return { insights: output.insights, log };
}
