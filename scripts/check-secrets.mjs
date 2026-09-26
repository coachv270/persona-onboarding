// Fails if any server-only secret value appears in the client bundle
// (.next/static). Run after `npm run build`: npm run check:secrets
// Prints variable names only, never values.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SERVER_ONLY = ["GOOGLE_GENERATIVE_AI_API_KEY", "ELEVENLABS_API_KEY", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET"];

const env = { ...process.env };
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch {}

const secrets = SERVER_ONLY.filter((k) => env[k] && env[k].length >= 8).map((k) => [k, env[k]]);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

const leaks = [];
for (const file of files(".next/static")) {
  const text = readFileSync(file, "utf8");
  for (const [name, value] of secrets) if (text.includes(value)) leaks.push(`${name} in ${file}`);
}

if (leaks.length) {
  console.error(`✗ Secret values found in the client bundle:\n  ${leaks.join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ No server secrets in the client bundle (checked ${secrets.map(([k]) => k).join(", ") || "nothing: no secrets set"})`);
