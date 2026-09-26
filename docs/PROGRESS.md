# Progress

Status snapshot as of **2026-09-26**.

## Goal

Persona trial assignment: a conversational onboarding that collects:

1. The agent (assistant) name
2. The user's name
3. A Gmail connection
4. Something the user needs help with

It should try a web voice call to collect everything except the agent name. It must survive user errors and hangups, must not feel like a form, must allow graduating early, and must be hosted.

## Stack

| Area | Choice |
|---|---|
| App / hosting | Next.js on Vercel |
| Text | Vercel AI SDK v7 + Gemini (`gemini-flash-latest`), client-side tools (`/api/chat`) |
| Voice | ElevenLabs Agents, `@elevenlabs/react` v1, WebRTC, conversation token from `/api/voice-token`, client tools |
| Gmail | Google Identity Services popup token flow, `gmail.readonly`, headers only. `/api/insights` (Gemini) turns them into up to 3 ideas |
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

## Remaining

- [ ] ElevenLabs API key: grant **ElevenAgents write** (`convai_write`) permission. `/api/voice-token` currently returns 401 `missing_permissions`. Editing the existing key keeps its value, so there's no need to touch Vercel or `.env.local`.
- [ ] Add reviewer emails as Google OAuth test users.
- [ ] End-to-end test of voice + Gmail, then the stress scenarios: hang up mid-call, refuse Gmail, out-of-order answers, "just let me in", silence, mic denied.

## `.env.local` status

| Variable | Status |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | set |
| `ELEVENLABS_AGENT_ID` | set |
| `ELEVENLABS_API_KEY` | set |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | set (public) |

## Notes / Gotchas

- `VoiceCall.tsx` overrides `firstMessage` only on callbacks (after a dropped call); first calls use the dashboard first message. Callbacks fail until the First message override is enabled in the ElevenLabs dashboard.
- Client tools only run in the web app. In the ElevenLabs console they fail or time out (see [VOICE_AGENT.md](VOICE_AGENT.md#testing-in-the-console)).

## Related Docs

- [SETUP.md](SETUP.md): account setup steps (Gemini, Google Cloud, ElevenLabs, Vercel)
- [VOICE_AGENT.md](VOICE_AGENT.md): voice prompt, first message, console testing
