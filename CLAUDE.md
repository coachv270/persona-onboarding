@AGENTS.md

# Project

Persona: one universal AI assistant (text chat via Gemini, browser voice call via ElevenLabs) that helps right away and sets itself up in the background. Capabilities unlock progressively: email help (summarize, find, read, draft; never send) works as soon as Gmail is connected. Profile: assistant name, user name, email, need, Gmail. Status: [docs/PROGRESS.md](docs/PROGRESS.md).

## Key files

| File | Role |
|---|---|
| `src/lib/onboarding.ts` | `OnboardingState`, `reducer`, `missingSlots`, `describeState`, `normalizeEmail`, `mailAccess`/`describeCapabilities` (progressive unlock), localStorage load/save |
| `src/lib/prompts.ts` | Chat prompt (`systemPrompt`), voice `{{known_info}}` (`voiceContext`), adaptive greeting (`voiceFirstMessage`) |
| `src/lib/tools.ts` | Chat tool schemas (`chatTools`), `ChatMessage` type, `GEMINI_MODEL` |
| `src/lib/gmail.ts` | GIS popup tokens (in-memory, per scope), rate-limited Gmail API: search (all received mail), read, create draft |
| `src/lib/mailCommands.ts` | Shared email commands (summarize, find, read, draft) returning text for the LLM |
| `src/lib/devlog.ts`, `src/components/DevPanel.tsx` | Timestamped event log + red Dev button (clear local data) |
| `src/components/App.tsx` | Loads persisted state/messages, handles "Start over" (client-only via `src/app/page.tsx`) |
| `src/components/Onboarding.tsx` | Layout, `runTool()` (the one implementation of every tool, used by chat and voice), chat, Gmail/draft cards, help actions |
| `src/components/VoiceCall.tsx` | ElevenLabs call; client tools are thin wrappers around `runTool` |
| `src/app/api/chat/route.ts` | Gemini streaming chat |
| `src/app/api/voice-token/route.ts` | Mints the ElevenLabs WebRTC conversation token (server-side key) |
| `src/app/api/insights/route.ts` | Gemini turns email headers into up to 3 ideas |
| `docs/VOICE_AGENT.md` | Voice agent prompt + first message (source of truth; `npm run sync:voice`) |
| `docs/SETUP.md` | Google Cloud, ElevenLabs, Vercel setup |

## Conventions

- Progressive unlock: never gate a request on setup. Locked capabilities explain what unlocks them.
- One implementation per capability: `runTool()` in `Onboarding.tsx`. Chat `onToolCall` and voice `useConversationClientTool` wrappers call it; names must match the ElevenLabs client tools.
- The LLM interprets, code checks (e.g. `normalizeEmail`). Every action goes to the dev log; never log tokens or email bodies.
- Voice prompt source of truth: `docs/VOICE_AGENT.md` → `npm run sync:voice`. Chat prompt: `src/lib/prompts.ts`. No em dashes in prompts or copy.
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
