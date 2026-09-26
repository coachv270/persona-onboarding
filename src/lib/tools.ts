import { tool, type InferUITools, type UIDataTypes, type UIMessage } from "ai";
import { z } from "zod";

// Chat tools have no `execute`: they're forwarded to the browser, which applies
// them to the shared onboarding state (see useChat onToolCall in Onboarding.tsx).
// Each returns a plain-text summary of the updated state to the model.
export const chatTools = {
  setAgentName: tool({
    description: "Save the name the user chose for you, the assistant.",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.string(),
  }),
  setUserName: tool({
    description: "Save the user's name as soon as they mention it.",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.string(),
  }),
  setHelpNeed: tool({
    description: "Save something concrete the user wants help with.",
    inputSchema: z.object({ need: z.string() }),
    outputSchema: z.string(),
  }),
  requestGmailConnect: tool({
    description: "Show the user a 'Connect Gmail' button.",
    inputSchema: z.object({}),
    outputSchema: z.string(),
  }),
  declineGmail: tool({
    description: "Record that the user doesn't want to connect Gmail right now.",
    inputSchema: z.object({}),
    outputSchema: z.string(),
  }),
  startCall: tool({
    description: "Ring the user for a quick voice call. Only after they agree to a call.",
    inputSchema: z.object({}),
    outputSchema: z.string(),
  }),
  graduate: tool({
    description: "Finish onboarding: everything is collected, or the user wants to skip ahead.",
    inputSchema: z.object({}),
    outputSchema: z.string(),
  }),
};

export type MessageMeta = {
  // Hidden event notes ("[Event] call ended…") that steer the model but aren't shown.
  hidden?: boolean;
  channel?: "voice";
};

export type ChatMessage = UIMessage<MessageMeta, UIDataTypes, InferUITools<typeof chatTools>>;

export const GEMINI_MODEL = "gemini-flash-latest";
