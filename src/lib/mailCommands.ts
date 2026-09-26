// Shared email commands. Chat tools and voice client tools are thin wrappers
// around these, so both channels behave identically. Each returns plain text
// for the LLM plus optional UI side effects for the caller to apply.

import { devlog } from "./devlog";
import { GmailAuthError, getCachedToken, getMessage, READONLY, searchMessages, type Draft, type MailItem } from "./gmail";

export type Detail = "voice" | "text";

export interface MailResult {
  text: string;
  // "connect": show the Connect Gmail card. "reconnect": access expired this session.
  needs?: "connect" | "reconnect";
  draft?: Draft;
}

export interface MailContext {
  gmailConnected: boolean;
  detail: Detail;
}

const LOCKED =
  "Gmail isn't connected, so email help is locked. A Connect Gmail button is now showing — offer it in one sentence (read-only; nothing is ever sent).";
const EXPIRED =
  "Gmail access expired for this browser session. A Reconnect button is now showing — ask them to click it, then try again.";

async function withGmail(ctx: MailContext, name: string, fn: (token: string) => Promise<MailResult>): Promise<MailResult> {
  if (!ctx.gmailConnected) {
    devlog("gmail", `${name}: locked (Gmail not connected)`);
    return { text: LOCKED, needs: "connect" };
  }
  const token = getCachedToken(READONLY);
  if (!token) {
    devlog("gmail", `${name}: needs reconnect (no token this session)`);
    return { text: EXPIRED, needs: "reconnect" };
  }
  try {
    return await fn(token);
  } catch (e) {
    if (e instanceof GmailAuthError) return { text: EXPIRED, needs: "reconnect" };
    const message = e instanceof Error ? e.message : String(e);
    devlog("error", `${name}: ${message}`);
    return { text: `Gmail request failed (${message}). Apologize briefly and offer to try again.` };
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
      return `${i + 1}. [id ${m.id}] ${from} · ${m.subject || "(no subject)"} · ${m.date}${snippet ? ` — ${snippet}` : ""}`;
    })
    .join("\n");
}

const VOICE_HINT = "Answer aloud in 2–3 short sentences; don't read ids or addresses.";

export function summarizePeriod(args: { after: string; before?: string }, ctx: MailContext): Promise<MailResult> {
  return withGmail(ctx, "summarizeInbox", async (token) => {
    const after = toEpoch(args.after);
    const before = args.before ? toEpoch(args.before) : null;
    if (after === null || (args.before && before === null)) {
      return { text: `Invalid date(s): after="${args.after}" before="${args.before ?? ""}". Use ISO 8601, e.g. 2026-09-25T00:00:00-07:00.` };
    }
    const q = `in:inbox -category:promotions -category:social after:${after}${before ? ` before:${before}` : ""}`;
    const { items, estimate } = await searchMessages(token, q, 30);
    devlog("gmail", `summarizeInbox ${args.after} → ${args.before ?? "now"}: ${items.length} emails (~${estimate})`);
    if (!items.length) return { text: "No emails in that period (excluding promotions and social)." };
    return {
      text:
        `${items.length} emails${estimate > items.length ? ` (showing the latest ${items.length} of ~${estimate})` : ""}:\n` +
        `${formatItems(items, ctx.detail)}\n\n` +
        `Summarize for the user: group by theme, call out anything that needs a reply or action. ` +
        (ctx.detail === "voice" ? VOICE_HINT : "Keep it scannable."),
    };
  });
}

export function findEmails(args: { query: string }, ctx: MailContext): Promise<MailResult> {
  return withGmail(ctx, "findEmails", async (token) => {
    const { items } = await searchMessages(token, args.query, 5);
    devlog("gmail", `findEmails "${args.query}": ${items.length} results`);
    if (!items.length) return { text: `No emails match "${args.query}". Suggest a different search.` };
    return {
      text:
        `${formatItems(items, ctx.detail)}\n\n` +
        (items.length > 1
          ? "If it's unclear which one they mean, ask. Otherwise use readEmail with the id."
          : "Use readEmail with this id to open it."),
    };
  });
}

export function readEmail(args: { id: string }, ctx: MailContext): Promise<MailResult> {
  return withGmail(ctx, "readEmail", async (token) => {
    const m = await getMessage(token, args.id, ctx.detail === "voice" ? 1500 : 6000);
    devlog("gmail", `readEmail ${args.id}: ${m.body.length} chars`);
    return {
      text:
        `From: ${m.from}\nTo: ${m.to}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body || m.snippet}\n\n` +
        (ctx.detail === "voice" ? VOICE_HINT : "Summarize or answer their question about it."),
    };
  });
}

export function prepareDraft(args: { messageId: string; body: string }, ctx: MailContext): Promise<MailResult> {
  return withGmail(ctx, "showDraft", async (token) => {
    const m = await getMessage(token, args.messageId, 500);
    const draft: Draft = {
      id: crypto.randomUUID(),
      threadId: m.threadId,
      to: m.replyTo || m.from,
      subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      body: args.body,
      inReplyTo: m.messageId,
      references: [m.references, m.messageId].filter(Boolean).join(" "),
    };
    devlog("gmail", `showDraft for ${args.messageId}: reply to ${draft.to.replace(/.*</, "<")}`);
    return {
      draft,
      text: "The draft is on screen. Tell them they can edit it, copy it, or save it to Gmail Drafts. It is NOT sent — never say it was.",
    };
  });
}
