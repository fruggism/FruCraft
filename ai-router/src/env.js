// Legge il file .env (CHIAVE=valore per riga). Le variabili già impostate
// nel sistema hanno la precedenza.

import fs from 'node:fs';

export function loadEnv(file) {
  const env = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const quoted = m[2].match(/^(['"])(.*)\1$/);
    env[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '');
  }
  for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;
  return env;
}
