# Progress

Status snapshot as of **2026-09-26**.

## Goal

Persona trial assignment, now one universal assistant with progressive unlock:
- It helps right away in text or voice. Setup (assistant name, user name, email, need, Gmail) happens in the background and never gates a request.
- Email help unlocks once Gmail is connected: summarize a period, find or read an email, and draft replies that are never sent (Copy or Save to Gmail Drafts).
- Names and emails can be spelled by voice or text; code validates the result.
- It survives hangups and user errors, doesn't feel like a form, and is hosted.

## Stack

| Area | Choice |
|---|---|
| App / hosting | Next.js on Vercel |
| Text | Vercel AI SDK v7 + Gemini (`gemini-flash-latest`), client-side tools (`/api/chat`) |
| Voice | ElevenLabs Agents, `@elevenlabs/react` v1, WebRTC, conversation token from `/api/voice-token`, client tools |
| Gmail | Google Identity Services popup token flow (`gmail.readonly`; `gmail.compose` only for Save to Drafts). Search, read and draft in the browser via `mailCommands.ts` |
| State | One reducer shared by chat and voice (`src/lib/onboarding.ts`), persisted in `localStorage` |

## Done

- [x] Scaffold built. Typecheck, lint and build pass.
- [x] Public repo: https://github.com/coachv270/persona-onboarding (`main`; pushes auto-deploy to Vercel).
- [x] ElevenLabs agent "My Agent" (`agent_2301m3frxgp4f9vbd0ksry9tg3yh`): system prompt and first message from [VOICE_AGENT.md](VOICE_AGENT.md) entered and published. Dynamic-variable test values set (`agent_name=Nova`, `known_info`).
- [x] Google Cloud project `persona-onboarding` (id `persona-onboarding-509821`, org powercrafttraining.com): Gmail API enabled. OAuth consent is External and in Testing, app name "Persona Onboarding", test user coachv@powercrafttraining.com.
- [x] App fills the dashboard prompt via dynamic variables (`agent_name`, `known_info`) instead of overriding the prompt.
- [x] Google: `gmail.readonly` scope added. Web OAuth client created with origins `https://persona-onboarding-phi.vercel.app` and `http://localhost:3000`.
- [x] Vercel project `persona-onboarding` deployed: **https://persona-onboarding-phi.vercel.app** (first deploy had no env values).
- [x] ElevenLabs API key created and put in `.env.local`.
- [x] Vercel env vars set (Production + Preview) and redeployed. Verified live: chat and tool calls work; Google client ID is in the bundle.
- [x] ElevenLabs agent configured and **published**: 4 client tools, End conversation, authentication, First-message override (see [VOICE_AGENT.md](VOICE_AGENT.md#agent-configuration-live)).

- [x] Adaptive UI: profile fields (assistant name, your name, need, Gmail) editable directly; chat and call can fill any of them; call available anytime. Voice agent got `setAgentName` + prompt for an unnamed start (verified via ElevenLabs simulation).
- [x] Dev panel (top right): timestamped log of chat, tools, voice, state, Gmail and errors; "Clear local data" with confirmation.
- [x] Gmail popup flow verified end to end on localhost.

## Done on `feature/universal-assistant`

- [x] One assistant, progressive unlock; no graduation screen or Skip ahead.
- [x] Email slot + spelling (validated by `normalizeEmail`), Google account wins.
- [x] Mail commands for chat and voice via one `runTool()`; search covers all received mail (archived and read included).
- [x] Drafts: editable, Copy, Save to Gmail Drafts (compose scope on click). `gmail.compose` added in Google Cloud.
- [x] Voice agent: 11 client tools published, unified prompt synced via `npm run sync:voice`.
- [x] Persona-style UI (light, SF Pro/Inter, iMessage bubbles), help actions + numbered "How it works" on the right, compact mobile layout, voice lines tagged and calls marked with dividers.

## Remaining

- [ ] End-to-end on localhost with Gmail: "summarize yesterday", find/read, draft → Save to Gmail Drafts (appears in the thread, unsent), reload → Reconnect.
- [ ] Voice: "what came in today?" should call summarizeInbox (not answer from memory); spelling an email; "no Gmail" → declineGmail.
- [ ] Add reviewer emails as Google test users.
- [ ] Merge the branch to `main` (deploys to Vercel).

## `.env.local` status

| Variable | Status |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | set |
| `ELEVENLABS_AGENT_ID` | set |
| `ELEVENLABS_API_KEY` | set |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | set (public) |

## Notes / Gotchas

- `VoiceCall.tsx` always overrides `firstMessage` with `voiceFirstMessage()` (adapts to what's known). Requires the First message override, which is enabled.
- Client tools only run in the web app. In the ElevenLabs console they fail or time out (see [VOICE_AGENT.md](VOICE_AGENT.md#testing-in-the-console)).

## Related Docs

- [SETUP.md](SETUP.md): account setup steps (Gemini, Google Cloud, ElevenLabs, Vercel)
- [VOICE_AGENT.md](VOICE_AGENT.md): voice prompt, first message, console testing
