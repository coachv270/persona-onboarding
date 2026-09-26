# Persona

One personal AI assistant you can **talk to** (browser voice call), **text** (chat), or **fill in** (on-screen fields). It helps right away and sets itself up in the background. Email help unlocks as soon as Gmail is connected.

Live: https://persona-onboarding-phi.vercel.app · Status: [docs/PROGRESS.md](docs/PROGRESS.md)

## TL;DR

- **Next.js 16 on Vercel.** Nearly everything runs in the browser. The server only holds API keys (3 small routes).
- **Chat:** Vercel AI SDK v7 + Gemini. **Voice:** ElevenLabs Agents over WebRTC. **Gmail:** Google popup token, called from the browser.
- **One state object** (`src/lib/onboarding.ts`) is shared by chat, voice and the fields, and saved in `localStorage`. No database, no user accounts.
- **One implementation per tool:** `runTool()` in `Onboarding.tsx`. Chat tool calls and voice client tools both call it.
- **Progressive unlock:** a request is never blocked on setup. Mail tools work once Gmail is connected; otherwise the assistant says what unlocks them.
- **Never sends email.** Drafts are shown for Copy or **Save to Gmail Drafts** (`gmail.compose` is requested only on that click).
- **Debugging:** the red **Dev** button (top right) shows a timestamped log of every chat turn, tool call, voice event, state change, Gmail request and error.

```bash
cp .env.example .env.local   # 4 values, see docs/SETUP.md
npm install
npm run dev                  # http://localhost:3000
```

## How it works

```
             ┌──────────── browser ─────────────────────────────────────────┐
  type ────► │ ProfileCard fields ─┐                                        │
  text ────► │ useChat ─ onToolCall ┼──► runTool(name, args) ──► reducer ───┼─► localStorage
  talk ────► │ ElevenLabs client   ─┘        │                    (state)  │
             │   tools                        └─► mailCommands ─► Gmail API│
             └──────┬──────────────────────┬──────────────────────────────┘
                    │ /api/chat            │ /api/voice-token
                    ▼                      ▼
                 Gemini           ElevenLabs agent (WebRTC)
```

1. **Chat** (`/api/chat`): `streamText` with Gemini. None of the tools have a server `execute`, so each tool call goes to the browser's `onToolCall`, which calls `runTool()`. The result is sent back and the model continues (up to 6 steps). The request carries the current state, whether Gmail access is live, and the user's local time.
2. **Voice** (`VoiceCall.tsx`): `/api/voice-token` mints a single-use token for the private ElevenLabs agent. At call start the app sends `{{agent_name}}` and `{{known_info}}` (profile, capabilities, time) plus an adaptive first message. The agent's client tools are thin wrappers around the same `runTool()`. Things that happen on screen during a call (typing into a field, connecting Gmail, saving a draft) are pushed to the agent as contextual updates.
3. **Gmail** (`gmail.ts`, `mailCommands.ts`): a Google popup token flow. It's a popup, not a redirect, so a live call survives it. Tokens live in memory only; after a reload the user reconnects. Search covers all received mail (archived and read included) and runs at most 8 requests in parallel, with a retry on 429. Commands return plain text for the model, plus side effects the UI applies (show the Connect card, show a draft).
4. **Handoffs:** when a call ends, the chat gets a hidden `[Event]` message and continues. The transcript shows spoken lines tagged "voice", with call dividers around them. Dividers are never sent to the model.

## Project map

| Path | What |
|---|---|
| `src/components/Onboarding.tsx` | Layout, `runTool()`, chat, Gmail and draft cards, help actions, "How it works" |
| `src/components/VoiceCall.tsx` | Call UI and lifecycle, voice client tools → `runTool()` |
| `src/components/DevPanel.tsx`, `src/lib/devlog.ts` | Event log, Copy JSON, clear local data |
| `src/components/ThemeToggle.tsx` | Light/dark switch (top left); dark by default |
| `src/lib/onboarding.ts` | State, reducer, `normalizeEmail`, `mailAccess` / `describeCapabilities` |
| `src/lib/prompts.ts` | Chat prompt, voice `known_info`, adaptive voice greeting |
| `src/lib/tools.ts` | Chat tool schemas (same names as the voice tools) |
| `src/lib/gmail.ts` | Popup tokens, rate-limited Gmail API: search, read, create draft |
| `src/lib/mailCommands.ts` | summarize, find, read, draft → text for the LLM |
| `src/app/api/*` | `chat` (Gemini), `voice-token` (ElevenLabs), `insights` (inbox ideas) |
| `docs/VOICE_AGENT.md` | Voice prompt (source of truth) and agent config |
| `scripts/sync-voice-prompt.mjs` | `npm run sync:voice` pushes the voice prompt to ElevenLabs |

## Rules of the codebase

- **The LLM interprets, code checks.** For example, the model turns "coach v at … dot com" into an address, and `normalizeEmail` validates it.
- **Add a capability once.** Add a case to `runTool()`, a schema in `tools.ts`, a client tool on the ElevenLabs agent with the **same name**, and a line in both prompts.
- **Log every action** with `devlog()`. Never log tokens or email bodies. Email bodies are also removed from saved chat history and from older model turns.
- **Voice prompt changes** go into `docs/VOICE_AGENT.md`, then `npm run sync:voice`. Pasting into the dashboard is unreliable.
- **Copy and prompts:** plain, human wording and no em dashes.
- The installed SDKs are newer than most training data (AI SDK v7, `@elevenlabs/react` v1). Check the types in `node_modules`.

## Environment

| Variable | Where | Notes |
|---|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | server | Gemini |
| `ELEVENLABS_API_KEY` | server | Needs **ElevenAgents: Write** |
| `ELEVENLABS_AGENT_ID` | server | The voice agent |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | browser | OAuth Web client; inlined at build, so redeploy after changing it |

Google OAuth is in **Testing** mode, so only listed test users can connect Gmail. The allowed origins are `localhost:3000` and the production URL, so Vercel preview URLs can't sign in. Full setup: [docs/SETUP.md](docs/SETUP.md).

## Commands

```bash
npm run dev          # local dev
npm run build        # production build
npm run lint
npx tsc --noEmit
npm run sync:voice   # push docs/VOICE_AGENT.md prompt to ElevenLabs
```

Pushing to `main` deploys to Vercel. Never commit `.env.local`.
