import fs from 'fs';
import path from 'path';

const envPath = 'C:/Users/akash/OneDrive/Desktop/main-logic/.env';

function parseEnv(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const config = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    config[key] = val;
  });
  return config;
}

const env = parseEnv(envPath);
const endpoint = env.AZURE_CONTENT_SAFETY_ENDPOINT;
const key = env.AZURE_CONTENT_SAFETY_KEY;

console.log('Endpoint:', endpoint);
console.log('Key length:', key ? key.length : 0);

if (!endpoint || !key) {
  console.error('Error: AZURE_CONTENT_SAFETY_ENDPOINT or AZURE_CONTENT_SAFETY_KEY is missing');
  process.exit(1);
}

const base = endpoint.replace(/\/+$/, "");
const url = `${base}/contentsafety/text:analyze?api-version=2024-09-01`;

try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: "Hello, this is a safe test sentence to check text safety API.",
      categories: ["Hate", "SelfHarm", "Sexual", "Violence"],
      outputType: "FourSeverityLevels",
    }),
  });

  console.log('HTTP Status:', res.status, res.statusText);
  const json = await res.json();
  console.log('Response Body:', JSON.stringify(json, null, 2));
} catch (err) {
  console.error('Fetch Exception:', err);
}
