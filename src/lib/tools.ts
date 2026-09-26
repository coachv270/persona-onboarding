import { tool, type InferUITools, type UIDataTypes, type UIMessage } from "ai";
import { z } from "zod";

// Chat tools have no `execute`: they're forwarded to the browser (useChat
// onToolCall in Onboarding.tsx), which applies them to the shared state or runs
// the shared mail commands. Voice client tools use the same names.
// Each returns plain text for the model.
const clientTool = <T extends z.ZodRawShape>(description: string, shape: T) =>
  tool({ description, inputSchema: z.object(shape), outputSchema: z.string() });

export const chatTools = {
  // Profile
  setAgentName: clientTool("Save the name the user chose for you, the assistant.", { name: z.string() }),
  setUserName: clientTool("Save the user's name as soon as they mention it (assemble spelled letters).", { name: z.string() }),
  setUserEmail: clientTool("Save the user's email address after confirming it. Code validates the format.", {
    email: z.string().describe("A full address like name@example.com. Convert spoken 'at'/'dot' yourself."),
  }),
  setHelpNeed: clientTool("Save something concrete the user wants help with, as a short phrase.", { need: z.string() }),
  requestGmailConnect: clientTool("Show the user a 'Connect Gmail' button (they click it in the browser).", {}),
  declineGmail: clientTool("Record that the user doesn't want to connect Gmail right now.", {}),
  startCall: clientTool("Ring the user for a quick voice call. Only after they agree to a call.", {}),
  graduate: clientTool("Setup is finished or the user asked to stop setup questions. Features are never gated by this.", {}),

  // Email help (unlocked once Gmail is connected)
  summarizeInbox: clientTool("Fetch emails received in a period (all mail, including archived and read) so you can summarize them.", {
    after: z.string().describe("ISO 8601 start, in the user's timezone"),
    before: z.string().optional().describe("ISO 8601 end; omit for 'until now'"),
  }),
  findEmails: clientTool("Search all mail, including archived and read (Gmail search syntax; don't add in:inbox unless asked). Returns up to 5 matches with ids.", { query: z.string() }),
  readEmail: clientTool("Open one email by id (from findEmails/summarizeInbox).", { id: z.string() }),
  saveDraft: clientTool(
    "Save the latest draft on screen (including the user's edits) to Gmail Drafts. Only when they ask to save it. Never sends.",
    {},
  ),
  showDraft: clientTool("Show a reply draft on screen for the user to edit, copy or save to Gmail Drafts. Never sends.", {
    messageId: z.string().describe("id of the email being replied to"),
    body: z.string().describe("the reply text, plain"),
  }),
};

export type MessageMeta = {
  // Hidden event notes ("[Event] call ended…") that steer the model but aren't shown.
  hidden?: boolean;
  channel?: "voice";
  // UI-only call divider ("Call started" / "Call ended"); never sent to the model.
  divider?: boolean;
};

export type ChatMessage = UIMessage<MessageMeta, UIDataTypes, InferUITools<typeof chatTools>>;

export const GEMINI_MODEL = "gemini-flash-latest";
