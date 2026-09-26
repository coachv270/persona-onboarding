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
   - **Data access**: add `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.compose` (compose is requested only when the user clicks Save to Gmail Drafts).
4. **Clients → Create client → Web application**:
   - **Authorized JavaScript origins**: `http://localhost:3000` and `https://<your-app>.vercel.app`.
   - **Authorized redirect URIs**: none — the popup token flow doesn't use them.
5. `NEXT_PUBLIC_GOOGLE_CLIENT_ID=...` (the client ID is public by design; no client secret is used).

`gmail.readonly` is a restricted scope. Staying in **Testing** avoids Google's multi-week verification; the trade-off is the test-user allowlist.

## 3. ElevenLabs agent

https://elevenlabs.io/app/agents → **Create agent → Blank**.

- **Agent**: pick a voice; LLM = a Gemini Flash model. Set the first message from [VOICE_AGENT.md](VOICE_AGENT.md), then push the prompt with `npm run sync:voice` (pasting into the editor is unreliable). The app fills `{{agent_name}}` and `{{known_info}}` at call start.
- **Security**:
  - Enable the **First message** override (the app always sends a greeting that fits what's already known).
  - Enable **authentication** (private agent). The app mints a WebRTC conversation token server-side via `/api/voice-token`.
- **Tools → Add tool → Client tool** (tick **Wait for response** on each; names are case-sensitive and must match `src/components/VoiceCall.tsx`):

  | Name | Parameters | Timeout |
  |---|---|---|
  | `setAgentName` | `name` | 5 s |
  | `setUserName` | `name` | 5 s |
  | `setUserEmail` | `email` | 5 s |
  | `setHelpNeed` | `need` | 5 s |
  | `showGmailButton` | none | 5 s |
  | `declineGmail` | none | 5 s |
  | `graduate` (stop setup questions; never ends the call) | none | 5 s |
  | `summarizeInbox` | `after`, `before` (optional) | 20 s |
  | `findEmails` | `query` | 20 s |
  | `readEmail` | `id` | 20 s |
  | `showDraft` | `messageId`, `body` | 20 s |

  All parameters are strings. The quickest way is **Edit as JSON** with the template in [VOICE_AGENT.md](VOICE_AGENT.md).

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
