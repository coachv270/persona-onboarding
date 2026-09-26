// Push the voice agent's system prompt from docs/VOICE_AGENT.md to ElevenLabs.
// Usage: npm run sync:voice   (reads ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID from .env.local)
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { ELEVENLABS_API_KEY: key, ELEVENLABS_AGENT_ID: agent } = process.env;
if (!key || !agent) throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID must be set");

const doc = readFileSync("docs/VOICE_AGENT.md", "utf8");
const prompt = [...doc.matchAll(/```\w*\n([\s\S]*?)\n```/g)].map((m) => m[1]).find((b) => b.startsWith("# Who you are"));
if (!prompt) throw new Error("System prompt block not found in docs/VOICE_AGENT.md");

const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agent}`, {
  method: "PATCH",
  headers: { "xi-api-key": key, "content-type": "application/json" },
  body: JSON.stringify({ conversation_config: { agent: { prompt: { prompt } } } }),
});
if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
const live = (await res.json()).conversation_config.agent.prompt.prompt;
console.log(live === prompt ? `✓ Voice prompt synced (${prompt.length} chars)` : "✗ Prompt mismatch after sync");
