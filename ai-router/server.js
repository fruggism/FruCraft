/*
 * Il server del router: serve la pagina della chat e inoltra ogni messaggio
 * al modello scelto. Ascolta solo su questo computer (127.0.0.1): le chiavi
 * restano qui e non arrivano mai al browser.
 *
 *   npm start   → http://localhost:8787
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import defaultConfig from './config.js';
import { loadEnv } from './src/env.js';
import { Router } from './src/router.js';
import { Usage } from './src/usage.js';
import { streamChat, credentials } from './src/providers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIRST_TOKEN_TIMEOUT = 45000;

function readJson(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('messaggio troppo grande')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('JSON non valido')); }
    });
    req.on('error', reject);
  });
}

function validMessages(messages) {
  return Array.isArray(messages) && messages.length > 0 &&
    messages.every(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
}

export function createApp({ config = defaultConfig, env, usage }) {
  const router = new Router({ config, env, usage });
  const page = path.join(here, 'public', 'index.html');

  function stato() {
    return {
      soloGratis: env.SOLO_GRATIS === '1',
      classificatore: env.CLASSIFICATORE === 'regole' ? 'regole' : 'modello',
      categorie: Object.fromEntries(Object.entries(config.categories).map(([k, c]) => [k, c.descr])),
      fornitori: Object.entries(config.providers).map(([id, p]) => ({
        id, label: p.label, attivo: !!credentials(p, env), signup: p.signup, env: p.keyEnv || p.urlEnv,
      })),
      modelli: Object.entries(config.models).map(([id, m]) => ({
        id, label: m.label, free: m.free, provider: m.provider, stato: router.status(id),
        pausa: router.pauses.get(id)?.motivo, oggi: usage.today(id), limiteGiorno: m.limiteGiorno,
      })),
      uso: usage.recent(14),
    };
  }

  async function chat(req, res) {
    let body;
    try { body = await readJson(req); } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
    if (!validMessages(body.messages)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'messages deve essere una lista di {role, content}' }));
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const send = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const client = new AbortController();
    res.on('close', () => { if (!res.writableEnded) client.abort(); });

    const soloGratis = !!body.soloGratis;
    const userTexts = body.messages.filter(m => m.role === 'user').map(m => m.content);
    const text = userTexts[userTexts.length - 1] || '';

    let lista, route;
    try {
      if (body.model && body.model !== 'auto') {
        if (!config.models[body.model]) { send({ type: 'error', message: `modello sconosciuto: ${body.model}` }); return res.end(); }
        route = { categoria: null, motivo: 'scelto da te', via: 'manuale' };
        lista = [body.model];
      } else {
        route = await router.classify(text, { previous: userTexts[userTexts.length - 2], soloGratis, signal: client.signal });
        lista = router.candidates(route.categoria, { soloGratis });
      }
    } catch {
      return res.end();
    }
    send({ type: 'route', ...route });

    if (!lista.length) {
      send({
        type: 'error',
        message: soloGratis
          ? `Nessun modello gratuito disponibile per «${route.categoria}». Aggiungi una chiave nel file .env o togli «Solo gratis».`
          : `Nessun modello disponibile per «${route.categoria}». Aggiungi almeno una chiave nel file .env.`,
      });
      return res.end();
    }

    const messages = [{ role: 'system', content: config.settings.systemPrompt }, ...body.messages];
    for (const modelId of lista) {
      const attempt = new AbortController();
      const timer = setTimeout(() => attempt.abort(), FIRST_TOKEN_TIMEOUT);
      const signal = AbortSignal.any([client.signal, attempt.signal]);
      let chars = 0;
      try {
        const it = streamChat({ config, env, modelId, messages, signal })[Symbol.asyncIterator]();
        const first = await it.next();
        clearTimeout(timer);
        const m = config.models[modelId];
        send({ type: 'model', model: modelId, label: m.label, free: m.free });
        let step = first;
        while (!step.done) {
          chars += step.value.length;
          send({ type: 'delta', text: step.value });
          step = await it.next();
        }
        usage.add(modelId, chars);
        send({ type: 'done' });
        return res.end();
      } catch (err) {
        clearTimeout(timer);
        if (client.signal.aborted) return res.end();
        if (attempt.signal.aborted) err = Object.assign(new Error('nessuna risposta entro 45 secondi'), { status: 504 });
        const motivo = router.report(modelId, err);
        if (chars) {
          // Si è interrotto a metà: non si può ricominciare con un altro senza confondere la risposta.
          usage.add(modelId, chars);
          send({ type: 'error', message: `La risposta si è interrotta: ${motivo}` });
          return res.end();
        }
        send({ type: 'fallback', model: modelId, label: config.models[modelId].label, motivo });
      }
    }
    send({ type: 'error', message: 'Nessun modello ha risposto. Controlla le chiavi con npm run check.' });
    res.end();
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return fs.createReadStream(page).pipe(res);
      }
      if (req.method === 'GET' && url.pathname === '/api/stato') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(stato()));
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') return await chat(req, res);
      res.writeHead(404).end();
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = loadEnv(path.join(here, '.env'));
  const usage = new Usage(path.join(here, 'data', 'uso.json'));
  const port = Number(env.PORT) || 8787;
  const app = createApp({ env, usage });
  app.listen(port, '127.0.0.1', () => {
    const attivi = Object.values(defaultConfig.providers).filter(p => credentials(p, env)).map(p => p.label);
    console.log(`Router AI su http://localhost:${port}`);
    console.log(attivi.length ? `Fornitori attivi: ${attivi.join(', ')}` : 'Nessuna chiave trovata: copia .env.example in .env e aggiungine almeno una.');
  });
}
