# Persona onboarding

Conversational onboarding that collects an assistant name, the user's name, a Gmail connection and something they need help with, over text and a browser-based voice call.

- **Text:** Next.js + Vercel AI SDK + Gemini (`/api/chat`)
- **Voice:** ElevenLabs Agents over WebRTC (`/api/voice-token`)
- **Gmail:** Google Identity Services popup, read-only headers → Gemini suggestions (`/api/insights`)
- **State:** one reducer shared by chat and voice, saved to `localStorage` (`src/lib/onboarding.ts`)

## Run

```bash
cp .env.example .env.local   # fill in — see docs/SETUP.md
npm install
npm run dev
```

Account setup (Google Cloud, ElevenLabs agent, Vercel): [docs/SETUP.md](docs/SETUP.md).
