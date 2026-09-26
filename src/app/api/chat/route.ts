import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  pruneMessages,
  streamText,
  toUIMessageStream,
} from "ai";
import { google } from "@ai-sdk/google";
import { systemPrompt } from "@/lib/prompts";
import { chatTools, GEMINI_MODEL, type ChatMessage } from "@/lib/tools";
import type { OnboardingState } from "@/lib/onboarding";

export const maxDuration = 30;

interface ChatRequest {
  messages: ChatMessage[];
  onboardingState: OnboardingState;
  hasGmailToken: boolean;
  now: string;
  timeZone: string;
}

export async function POST(req: Request) {
  const { messages, onboardingState, hasGmailToken, now, timeZone }: ChatRequest = await req.json();

  const modelMessages = await convertToModelMessages(messages, { tools: chatTools, ignoreIncompleteToolCalls: true });

  const result = streamText({
    model: google(GEMINI_MODEL),
    instructions: systemPrompt(onboardingState, hasGmailToken, now, timeZone),
    // Old tool outputs (email bodies) don't need to ride along every turn.
    messages: pruneMessages({ messages: modelMessages, toolCalls: "before-last-2-messages" }),
    tools: chatTools,
    // find → read → draft chains need a few steps.
    stopWhen: isStepCount(6),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      onError: (e) => (e instanceof Error ? e.message : "Something went wrong"),
    }),
  });
}
