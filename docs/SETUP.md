# Setup

Four accounts need one-time configuration. Put the values in `.env.local` (copy `.env.example`) and in the Vercel project's environment variables.

## 1. Gemini

1. https://aistudio.google.com/apikey → **Create API key**
2. `GOOGLE_GENERATIVE_AI_API_KEY=...`

## 2. Google Cloud (Gmail OAuth)

In https://console.cloud.google.com:

1. Create a project (e.g. `persona-onboarding`).
2. **APIs & Services → Library → Gmail API → Enable**.
3. **Google Auth Platform** (OAuth consent screen):
   - **Branding**: app name + support email.
   - **Audience**: **External**, publishing status **Testing**. (Not "Internal" — reviewers outside the Workspace domain couldn't sign in.)
   - **Test users**: add every Google account that will try the demo (max 100). Anyone else gets `access_denied`.
   - **Data access**: add `https://www.googleapis.com/auth/gmail.readonly`.
4. **Clients → Create client → Web application**:
   - **Authorized JavaScript origins**: `http://localhost:3000` and `https://<your-app>.vercel.app`.
   - **Authorized redirect URIs**: none — the popup token flow doesn't use them.
5. `NEXT_PUBLIC_GOOGLE_CLIENT_ID=...` (the client ID is public by design; no client secret is used).

`gmail.readonly` is a restricted scope. Staying in **Testing** avoids Google's multi-week verification; the trade-off is the test-user allowlist.

## 3. ElevenLabs agent

https://elevenlabs.io/app/agents → **Create agent → Blank**.

- **Agent**: pick a voice; LLM = a Gemini Flash model. System prompt / first message can be placeholders — the app overrides both at call start from `src/lib/prompts.ts`.
- **Security**:
  - Enable **overrides** for **System prompt** and **First message**.
  - Enable **authentication** (private agent). The app mints a WebRTC conversation token server-side via `/api/voice-token`.
- **Tools → Add tool → Client tool** (tick **Wait for response** on each; names are case-sensitive and must match `src/components/VoiceCall.tsx`):

  | Name | Description | Parameters |
  |---|---|---|
  | `setUserName` | Save the user's name as soon as they say it. | `name` — string, required |
  | `setHelpNeed` | Save something concrete the user wants help with. | `need` — string, required |
  | `showGmailButton` | Show a "Connect Gmail" button on the user's screen. | — |
  | `graduate` | Onboarding is complete, or the user wants to skip ahead. | — |

- **System tools**: enable **End call**.
- **Advanced** (optional): lower the turn timeout / silence end-call timeout so a silent user gets re-prompted or disconnected gracefully.

Then:

```
ELEVENLABS_AGENT_ID=...
ELEVENLABS_API_KEY=...   # Settings → API keys
```

## 4. Vercel

1. Push the repo to GitHub.
2. https://vercel.com/new → import the repo (Hobby plan is fine).
3. Add the four environment variables above → **Deploy**.
4. Add the resulting `https://<app>.vercel.app` to the Google OAuth client's **Authorized JavaScript origins**.
