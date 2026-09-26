import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai";
import { google } from "@ai-sdk/google";
import { chatSystemPrompt } from "@/lib/prompts";
import { chatTools, GEMINI_MODEL, type ChatMessage } from "@/lib/tools";
import type { OnboardingState } from "@/lib/onboarding";

export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages, onboardingState }: { messages: ChatMessage[]; onboardingState: OnboardingState } =
    await req.json();

  const result = streamText({
    model: google(GEMINI_MODEL),
    instructions: chatSystemPrompt(onboardingState),
    messages: await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    tools: chatTools,
    stopWhen: isStepCount(3),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      onError: (e) => (e instanceof Error ? e.message : "Something went wrong"),
    }),
  });
}
