# Persona

One personal AI assistant you can **talk to** (browser voice call), **text** (chat), or **fill in** (on-screen fields). It helps right away and sets itself up in the background. Email help unlocks as soon as Gmail is connected.

Live: https://persona-onboarding-phi.vercel.app · Status: [docs/PROGRESS.md](docs/PROGRESS.md)

## TL;DR

- **Next.js 16 on Vercel.** The browser runs the UI. **Every third-party call runs in API routes:** Gemini, ElevenLabs call tokens and Gmail. No secret or Google token ever reaches the browser.
- **Chat:** Vercel AI SDK v7 + Gemini. **Voice:** ElevenLabs Agents over WebRTC. **Gmail:** the Google popup returns a one-time code, and the server keeps the tokens in an encrypted httpOnly cookie.
- **One state object** (`src/lib/onboarding.ts`) is shared by chat, voice and the fields, and saved in `localStorage`. No database, no user accounts.
- **One implementation per tool:** `runTool()` in `Onboarding.tsx`, used by chat tool calls and voice client tools alike. Mail tools call `POST /api/mail`.
- **Progressive unlock:** a request is never blocked on setup. Mail tools work once Gmail is connected; otherwise the assistant says what unlocks them.
- **Email capture:** typed, texted or spoken (spelled) addresses are validated in code, and the server checks whether it's a Google account (MX lookup). Google → Connect Gmail (pre-filled). Other providers → "connecting non-Google email is coming soon".
- **Never sends email.** Drafts are shown for Copy or **Save to Gmail Drafts** (`gmail.compose` is requested only on that click).
- **Debugging:** the red **Dev** button shows a timestamped log (including server-side Gmail steps) and the server session: account, scopes, and access-token expiry, with Force refresh and Disconnect.

```bash
cp .env.example .env.local   # 6 values, see docs/SETUP.md
npm install
npm run dev                  # http://localhost:3000
```

## How it works

```
 browser (no secrets, no Google tokens)                     server (API routes)
 ┌──────────────────────────────────────────┐   POST /api/chat       ┌──────────────┐
 │ fields ─┐                                 │ ─────────────────────► │ Gemini       │
 │ chat ───┼─► runTool(name, args) ─► state  │   POST /api/mail       ├──────────────┤
 │ voice ──┘        │                        │ ─────────────────────► │ Gmail API    │◄─ tokens in encrypted
 │                  └─ mail tools ───────────┘   /api/gmail/*         │ (refresh)    │   httpOnly cookie
 │ Google popup ──► one-time code ──────────────────────────────────► │ code → tokens│
 │ ElevenLabs SDK ◄── call token ──────────── GET /api/voice-token ◄─ │ ElevenLabs   │
 └──────────────────────────────────────────┘                        └──────────────┘
```

1. **Chat** (`/api/chat`): `streamText` with Gemini. None of the tools have a server `execute`, so each tool call goes to the browser's `onToolCall`, which calls `runTool()`. The result is sent back and the model continues (up to 6 steps).
2. **Voice** (`VoiceCall.tsx`): `/api/voice-token` mints a single-use token for the private ElevenLabs agent. The call starts with `{{agent_name}}`, `{{known_info}}` and an adaptive first message. Voice client tools are thin wrappers around the same `runTool()`. Events on screen during a call reach the agent as contextual updates.
3. **Gmail:**
   - The Google popup (`initCodeClient`) returns a one-time **code**. `/api/gmail/connect` exchanges it using the client secret and stores the refresh and access tokens in a sealed cookie.
   - `/api/mail` runs summarize, find, read, draft and save-draft on the server. It refreshes the access token as needed and runs at most 8 requests in parallel, with a retry on 429.
   - Search covers all received mail, archived and read included.
4. **Handoffs:** when a call ends, the chat gets a hidden `[Event]` message and continues. The transcript shows spoken lines tagged "voice", with call dividers around them. Dividers are never sent to the model.

## Security

**Where each secret lives**

| Secret | Lives in | Reaches the browser? |
|---|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | server env | No. Used only in `/api/chat` and `/api/insights` |
| `ELEVENLABS_API_KEY` | server env | No. The browser gets a single-use call token from `/api/voice-token` |
| `GOOGLE_CLIENT_SECRET` | server env | No. Used only to exchange the one-time code |
| `SESSION_SECRET` | server env | No. Encrypts the Gmail session cookie (AES-256-GCM) |
| Google refresh and access tokens | encrypted **httpOnly**, `Secure`, `SameSite=Lax` cookie | No. Page scripts can't read it, and it's useless without `SESSION_SECRET` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | client bundle | Yes, by design. A client ID is public |

**What protects them**

- **Server-only modules.** `src/lib/server/*` imports `server-only`, so accidentally importing it from a client component fails the build.
- **Bundle scan.** `npm run check:secrets` scans the built client bundle for the value of every server secret. Run it after `npm run build`; it prints names only.
- **Request guards.** State-changing routes (`/api/chat`, `/api/mail`, `/api/gmail/*`, `/api/insights`) reject other origins (Origin and Fetch Metadata check). `/api/voice-token` only answers same-origin browser fetches.
- **Least privilege.** Google gets `gmail.readonly`, plus `gmail.compose` only when the user clicks Save to Gmail Drafts. The ElevenLabs key only needs **ElevenAgents: Write**.
- **Disconnect** revokes the grant at Google and clears the cookie. It's in the Dev panel and in "Clear local data".
- **No secrets in logs.** Neither the Dev log nor server logs contain tokens or email bodies. Email bodies are also removed from saved chat history and from older model turns.

**Rules for contributors**

- Never prefix a secret with `NEXT_PUBLIC_`. Anything with that prefix is inlined into the browser bundle.
- Call third-party APIs only from `src/app/api/*` or `src/lib/server/*`, never from components.
- Never return a token or key in an API response. Return status only (see `GmailStatus`).
- Keep `.env.local` out of git (it's ignored). Put real values only in Vercel's environment variables, and use Vercel's **Sensitive** type for secrets.
- If a secret leaks: rotate it at the provider (Google Cloud client secret, ElevenLabs key, Gemini key), update Vercel and `.env.local`, and redeploy. Rotating `SESSION_SECRET` logs everyone out of Gmail.
- Known limits: there's no rate limiting, so someone could still hit the public routes directly (not a key leak, but it costs credits). Google OAuth is in Testing mode, so only listed users can connect, and refresh tokens expire after 7 days.

## Project map

| Path | What |
|---|---|
| `src/components/Onboarding.tsx` | Layout, `runTool()`, chat, Gmail and draft cards, help actions, "How it works" |
| `src/components/VoiceCall.tsx` | Call UI and lifecycle, voice client tools → `runTool()` |
| `src/components/DevPanel.tsx`, `src/lib/devlog.ts` | Event log, server Gmail session controls, clear local data |
| `src/components/ThemeToggle.tsx` | Light/dark switch (top left); dark by default |
| `src/lib/onboarding.ts` | State, reducer, `normalizeEmail`, `mailAccess` / `describeCapabilities` |
| `src/lib/prompts.ts` | Chat prompt, voice `known_info`, adaptive voice greeting |
| `src/lib/tools.ts` | Chat tool schemas (same names as the voice tools) |
| `src/lib/gmail.ts` | Browser: Google popup (code only), calls to `/api/gmail/*` and `/api/mail` |
| `src/lib/emailProvider.ts`, `src/app/api/email-provider` | Is an address a Google account? (gmail.com or Google-hosted MX, so Workspace domains count). Non-Google: "coming soon" |
| `src/lib/mailTypes.ts` | Types shared by browser and server (`MailResult`, `Draft`, `GmailStatus`) |
| `src/lib/server/session.ts` | Encrypted httpOnly session cookie |
| `src/lib/server/google.ts` | Code exchange, token refresh, revoke |
| `src/lib/server/gmailApi.ts` | Rate-limited Gmail API: search, read, create draft |
| `src/lib/server/mailCommands.ts` | summarize, find, read, draft, save → text for the LLM; inbox ideas |
| `src/lib/server/guard.ts` | Same-origin check for API routes |
| `src/app/api/*` | `chat`, `mail`, `gmail/{connect,status,disconnect,expire}`, `insights`, `email-provider`, `voice-token` |
| `docs/VOICE_AGENT.md` | Voice prompt (source of truth) and agent config |
| `scripts/*.mjs` | `sync:voice` (push voice prompt), `check:secrets` (bundle scan) |

## Rules of the codebase

- **The LLM interprets, code checks.** For example, the model turns "coach v at … dot com" into an address, and `normalizeEmail` validates it.
- **Add a capability once.** Add a case to `runTool()` (plus a server command if it needs an API), a schema in `tools.ts`, a client tool on the ElevenLabs agent with the **same name**, and a line in both prompts.
- **Log every action** with `devlog()`. Server routes return short `log` lines for the Dev panel.
- **Voice prompt changes** go into `docs/VOICE_AGENT.md`, then `npm run sync:voice`.
- **Copy and prompts:** plain, human wording and no em dashes.
- The installed SDKs are newer than most training data (AI SDK v7, `@elevenlabs/react` v1). Check the types in `node_modules`.

## Environment

| Variable | Where | Notes |
|---|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | server | Gemini |
| `ELEVENLABS_API_KEY` | server | Needs **ElevenAgents: Write** |
| `ELEVENLABS_AGENT_ID` | server | The voice agent |
| `GOOGLE_CLIENT_SECRET` | server | OAuth Web client secret (code exchange) |
| `SESSION_SECRET` | server | `openssl rand -base64 32`; encrypts the Gmail cookie |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | browser | Public client ID; inlined at build, so redeploy after changing it |

Google OAuth is in **Testing** mode, so only listed test users can connect Gmail. The allowed origins are `localhost:3000` and the production URL, so Vercel preview URLs can't sign in. Full setup: [docs/SETUP.md](docs/SETUP.md).

## Commands

```bash
npm run dev            # local dev
npm run build          # production build
npm run check:secrets  # after build: no server secrets in the client bundle
npm run lint
npx tsc --noEmit
npm run sync:voice     # push docs/VOICE_AGENT.md prompt to ElevenLabs
```

Pushing to `main` deploys to Vercel. Never commit `.env.local`.
