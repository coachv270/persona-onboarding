// Mints a short-lived WebRTC conversation token for the private ElevenLabs
// agent, so the API key never reaches the browser.
export async function GET() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!apiKey || !agentId) {
    return Response.json({ error: "ElevenLabs is not configured" }, { status: 500 });
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { "xi-api-key": apiKey }, cache: "no-store" },
  );
  if (!res.ok) {
    return Response.json({ error: `ElevenLabs ${res.status}: ${await res.text()}` }, { status: 502 });
  }

  const { token } = (await res.json()) as { token: string };
  return Response.json({ token });
}
