import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { rulesClassify, parseClassification, Router } from '../src/router.js';
import { toAnthropic, sseData } from '../src/providers.js';
import { Usage } from '../src/usage.js';
import { createApp } from '../server.js';

test('le regole riconoscono i tipi di task', () => {
  assert.equal(rulesClassify('mi correggi questa funzione python?').categoria, 'codice');
  assert.equal(rulesClassify('```js\nconst a = 1\n```').categoria, 'codice');
  assert.equal(rulesClassify('calcola la rata del mutuo a 20 anni').categoria, 'ragionamento');
  assert.equal(rulesClassify("scrivimi un'email per disdire la palestra").categoria, 'scrittura');
  assert.equal(rulesClassify('che ore sono a Tokyo?').categoria, 'veloce');
  assert.equal(rulesClassify('x'.repeat(9000)).categoria, 'documenti');
  // "api" in italiano sono le api: non è codice.
  assert.equal(rulesClassify('le api fanno il miele?').categoria, 'veloce');
});

test('la risposta del classificatore viene letta anche se sporca', () => {
  const names = ['veloce', 'codice'];
  assert.deepEqual(parseClassification('{"categoria":"codice","motivo":"chiede uno script"}', names),
    { categoria: 'codice', motivo: 'chiede uno script' });
  assert.equal(parseClassification('Ecco: ```json\n{"categoria": "Veloce"}\n```', names).categoria, 'veloce');
  assert.equal(parseClassification('direi codice', names).categoria, 'codice');
  assert.equal(parseClassification('boh', names), null);
});

const config = {
  providers: {
    free: { label: 'Free', type: 'openai', baseUrl: 'http://x', keyEnv: 'FREE_KEY' },
    paid: { label: 'Paid', type: 'openai', baseUrl: 'http://x', keyEnv: 'PAID_KEY' },
    none: { label: 'None', type: 'openai', baseUrl: 'http://x', keyEnv: 'NONE_KEY' },
  },
  models: {
    a: { provider: 'free', model: 'a', free: true, label: 'A', limiteGiorno: 2 },
    b: { provider: 'none', model: 'b', free: true, label: 'B' },
    c: { provider: 'paid', model: 'c', free: false, label: 'C' },
  },
  categories: { veloce: { descr: '', models: ['a', 'b', 'c'] } },
  routerModels: ['a'],
  settings: { systemPrompt: 'sys', maxTokens: 100 },
};

test('i candidati saltano chi non ha chiave, chi è in pausa e chi ha finito il limite', () => {
  let now = 0;
  const usage = new Usage(null);
  const r = new Router({ config, env: { FREE_KEY: 'k', PAID_KEY: 'k' }, usage, now: () => now });
  assert.deepEqual(r.candidates('veloce'), ['a', 'c']);
  assert.deepEqual(r.candidates('veloce', { soloGratis: true }), ['a']);

  r.report('a', { status: 429, retryAfter: 5, message: '' });
  assert.deepEqual(r.candidates('veloce'), ['c']);
  now = 6000;
  assert.deepEqual(r.candidates('veloce'), ['a', 'c']);

  usage.add('a', 10); usage.add('a', 10);
  assert.equal(r.status('a'), 'limite-giorno');
  assert.deepEqual(r.candidates('veloce'), ['c']);
});

test('una richiesta rifiutata non mette in pausa il modello', () => {
  const r = new Router({ config, env: { FREE_KEY: 'k' }, usage: new Usage(null) });
  r.report('a', { status: 400, message: 'input too long' });
  assert.equal(r.status('a'), 'ok');
  r.report('a', { status: 404, message: 'not found' });
  assert.equal(r.status('a'), 'in-pausa');
});

test('il formato Anthropic separa il sistema e alterna i turni', () => {
  assert.deepEqual(toAnthropic([
    { role: 'system', content: 's' },
    { role: 'assistant', content: 'ciao' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
  ]), { system: 's', messages: [{ role: 'user', content: 'a\n\nb' }, { role: 'assistant', content: 'c' }] });
});

test('lo stream SSE viene diviso anche a metà riga', async () => {
  const enc = new TextEncoder();
  async function* chunks() { yield enc.encode('data: {"a"'); yield enc.encode(':1}\n\ndata: [DONE]\n'); }
  const out = [];
  for await (const d of sseData(chunks())) out.push(d);
  assert.deepEqual(out, ['{"a":1}', '[DONE]']);
});

// Un finto fornitore compatibile OpenAI: il modello "pieno" risponde 429,
// "buono" risponde in streaming.
function fakeUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const json = JSON.parse(body);
      seen.push(json.model);
      if (json.model === 'pieno') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
        return res.end(JSON.stringify({ error: { message: 'quota' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const t of ['Ciao', ' mondo']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return { server, seen };
}

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('il server passa al modello successivo se il primo ha finito la quota', async () => {
  const up = fakeUpstream();
  const upPort = await listen(up.server);
  const cfg = {
    providers: { f: { label: 'F', type: 'openai', baseUrl: `http://127.0.0.1:${upPort}`, keyEnv: 'K' } },
    models: {
      pieno: { provider: 'f', model: 'pieno', free: true, label: 'Pieno' },
      buono: { provider: 'f', model: 'buono', free: true, label: 'Buono' },
    },
    categories: { veloce: { descr: '', models: ['pieno', 'buono'] } },
    routerModels: [],
    settings: { systemPrompt: 'sys', maxTokens: 100 },
  };
  const usage = new Usage(null);
  const app = createApp({ config: cfg, env: { K: 'k' }, usage });
  const port = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ciao' }] }),
    });
    const events = (await res.text()).split('\n\n').filter(Boolean).map(l => JSON.parse(l.slice(5)));
    assert.deepEqual(events.map(e => e.type), ['route', 'fallback', 'model', 'delta', 'delta', 'done']);
    assert.equal(events[0].categoria, 'veloce');
    assert.equal(events[2].model, 'buono');
    assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), 'Ciao mondo');
    assert.deepEqual(up.seen, ['pieno', 'buono']);
    assert.equal(usage.today('buono'), 1);

    // Il modello in pausa non viene nemmeno riprovato.
    await (await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ancora' }] }),
    })).text();
    assert.deepEqual(up.seen, ['pieno', 'buono', 'buono']);
  } finally {
    app.close(); up.server.close();
  }
});
