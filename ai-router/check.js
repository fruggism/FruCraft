/*
 * Controlla ogni modello configurato con una richiesta minuscola.
 * Se un nome non esiste più, mostra quelli che il fornitore offre oggi.
 *
 *   npm run check
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import { loadEnv } from './src/env.js';
import { complete, credentials } from './src/providers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = loadEnv(path.join(here, '.env'));

async function listModels(provider, cred) {
  const headers = provider.type === 'anthropic'
    ? { 'x-api-key': cred.apiKey, 'anthropic-version': '2023-06-01' }
    : cred.apiKey ? { authorization: `Bearer ${cred.apiKey}` } : {};
  const res = await fetch(`${cred.baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const json = await res.json();
  let ids = (json.data || json.models || []).map(m => m.id || m.name).filter(Boolean);
  if (provider === config.providers.openrouter) ids = ids.filter(id => id.endsWith(':free'));
  return ids.map(id => id.replace(/^models\//, ''));
}

let ok = 0, ko = 0;
for (const [pid, provider] of Object.entries(config.providers)) {
  const cred = credentials(provider, env);
  if (!cred) {
    console.log(`\n· ${provider.label}: non configurato (${provider.keyEnv || provider.urlEnv} nel .env) — ${provider.signup}`);
    continue;
  }
  console.log(`\n■ ${provider.label}`);
  let suggerito = false;
  for (const [id, m] of Object.entries(config.models).filter(([, m]) => m.provider === pid)) {
    try {
      const reply = await complete({
        config, env, modelId: id,
        messages: [{ role: 'user', content: 'Rispondi solo con la parola: ok' }],
        signal: AbortSignal.timeout(30000),
      });
      console.log(`  ✓ ${id} (${m.model}) → ${JSON.stringify(reply.trim().slice(0, 30))}`);
      ok++;
    } catch (err) {
      console.log(`  ✗ ${id} (${m.model}) → ${err.status || ''} ${err.message}`);
      ko++;
      if (!suggerito && (err.status === 404 || err.status === 400)) {
        suggerito = true;
        const ids = await listModels(provider, cred).catch(() => []);
        if (ids.length) console.log(`    Modelli offerti ora (da mettere in config.js):\n      ${ids.slice(0, 25).join('\n      ')}`);
      }
    }
  }
}
console.log(`\n${ok} modelli funzionanti, ${ko} con errori.`);
