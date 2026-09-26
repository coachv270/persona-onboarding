@AGENTS.md

# Project

Persona onboarding: a Next.js app where a new AI assistant gets to know its user through text chat (Gemini) and a browser voice call (ElevenLabs). It collects the assistant's name, the user's name, a Gmail connection and something the user needs help with. Status: [docs/PROGRESS.md](docs/PROGRESS.md).

## Key files

| File | Role |
|---|---|
| `src/lib/onboarding.ts` | `OnboardingState`, `reducer`, `missingSlots`, `describeState` (state summary fed to both LLMs), localStorage load/save |
| `src/lib/prompts.ts` | Text chat system prompt (`chatSystemPrompt`), voice greeting (`voiceFirstMessage`) |
| `src/lib/tools.ts` | Chat tool schemas (`chatTools`), `ChatMessage` type, `GEMINI_MODEL` |
| `src/lib/gmail.ts` | GIS popup token flow, Gmail headers fetch (`fetchRecentMail`) |
| `src/components/App.tsx` | Loads persisted state/messages, handles "Start over" (client-only via `src/app/page.tsx`) |
| `src/components/Onboarding.tsx` | Chat UI, `useChat` + `onToolCall`, Gmail button, hidden `[Event]` messages |
| `src/components/VoiceCall.tsx` | ElevenLabs call, voice client tools, dynamic variables, contextual updates |
| `src/app/api/chat/route.ts` | Gemini streaming chat |
| `src/app/api/voice-token/route.ts` | Mints the ElevenLabs WebRTC conversation token (server-side key) |
| `src/app/api/insights/route.ts` | Gemini turns email headers into up to 3 ideas |
| `docs/VOICE_AGENT.md` | Voice agent prompt + first message (source of truth) |
| `docs/SETUP.md` | Google Cloud, ElevenLabs, Vercel setup |

## Conventions

- One shared `OnboardingState`. Chat tools and voice tools both dispatch the same reducer actions.
- Chat tools have no server `execute`. They are handled in `useChat`'s `onToolCall` (`Onboarding.tsx`).
- Voice tools are registered with `useConversationClientTool` (`VoiceCall.tsx`). Their names must match the ElevenLabs dashboard client tools.
- The voice prompt's source of truth is `docs/VOICE_AGENT.md`, pasted into the dashboard. The text prompt lives in `src/lib/prompts.ts`.
- Gmail must use the popup flow, never a redirect (a redirect would kill the call).
- Installed SDKs are newer than typical training data. Check the types in `node_modules`:
  - AI SDK v7: `instructions`, `isStepCount`, `addToolOutput`, `Output.object`
  - `@elevenlabs/react` v1: needs `ConversationProvider`
- Docs live in `docs/` with UPPERCASE names.

## Commands

```bash
npm run dev
npm run build
npm run lint
npx tsc --noEmit
```

Never commit `.env.local`.
