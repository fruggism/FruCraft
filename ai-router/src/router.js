/*
 * La scelta del modello: prima si capisce che tipo di task è (con un modello
 * gratuito che fa da classificatore, o con regole a parole chiave), poi si
 * prende il primo modello disponibile della lista di quella categoria.
 * I modelli che danno errore restano in pausa per un po' e si passa al
 * successivo.
 */

import { credentials, complete } from './providers.js';

const CODE_RE = /```|\b(codice|funzione|script|bug|debug|compil\w*|stack ?trace|regex|sql|javascript|typescript|python|java|html|css|json|bash|terminale|programm\w*|excel|formula)\b/i;
const REASON_RE = /\b(calcol\w*|dimostr\w*|risolv\w*|equazion\w*|probabilit\w*|analizz\w*|confront\w*|ragion\w*|strategi\w*|pianific\w*|conviene|pro e contro)/i;
const WRITE_RE = /\b(scrivi|scrivere|scrivimi|riscrivi|email|e-mail|mail|lettera|post|articolo|racconto|storia|poesia|testo|riassum\w*|traduc\w*|traduzione|slogan|descrizione)\b/i;

// Le regole a parole chiave: gratis, istantanee, approssimative.
export function rulesClassify(text) {
  if (text.length > 8000) return { categoria: 'documenti', motivo: 'testo molto lungo' };
  if (CODE_RE.test(text)) return { categoria: 'codice', motivo: 'parla di codice' };
  if (REASON_RE.test(text)) return { categoria: 'ragionamento', motivo: 'chiede di ragionare o calcolare' };
  if (WRITE_RE.test(text)) return { categoria: 'scrittura', motivo: 'chiede di scrivere un testo' };
  if (text.length < 300) return { categoria: 'veloce', motivo: 'domanda breve' };
  return { categoria: 'ragionamento', motivo: 'richiesta articolata' };
}

export function classifierPrompt(categories, text, previous) {
  const list = Object.entries(categories).map(([name, c]) => `- ${name}: ${c.descr}`).join('\n');
  const context = previous ? `Messaggio precedente (solo contesto):\n${previous.slice(0, 500)}\n\n` : '';
  return [
    {
      role: 'system',
      content: `Classifica la richiesta dell'utente in UNA di queste categorie:\n${list}\n\n` +
        'Rispondi solo con JSON, senza altro testo: {"categoria": "<nome>", "motivo": "<al massimo 8 parole, in italiano>"}',
    },
    { role: 'user', content: `${context}Richiesta da classificare:\n${text.slice(0, 2000)}` },
  ];
}

// La risposta del classificatore, o null se non contiene una categoria valida.
export function parseClassification(raw, names) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const json = JSON.parse(match[0]);
      const categoria = String(json.categoria || '').toLowerCase().trim();
      if (names.includes(categoria)) return { categoria, motivo: String(json.motivo || '').slice(0, 80) };
    } catch {}
  }
  const lower = raw.toLowerCase();
  const found = names.find(n => lower.includes(n));
  return found ? { categoria: found, motivo: '' } : null;
}

export class Router {
  constructor({ config, env, usage, now = () => Date.now() }) {
    this.config = config;
    this.env = env;
    this.usage = usage;
    this.now = now;
    this.pauses = new Map(); // modelId → { until, motivo }
  }

  // 'ok', oppure perché il modello ora non si può usare.
  status(modelId) {
    const m = this.config.models[modelId];
    if (!m) return 'sconosciuto';
    if (!credentials(this.config.providers[m.provider], this.env)) return 'senza-chiave';
    const pause = this.pauses.get(modelId);
    if (pause && pause.until > this.now()) return 'in-pausa';
    if (m.limiteGiorno && this.usage.today(modelId) >= m.limiteGiorno) return 'limite-giorno';
    return 'ok';
  }

  usable(ids, { soloGratis = false } = {}) {
    return ids.filter(id => this.status(id) === 'ok' && (!soloGratis || this.config.models[id].free));
  }

  candidates(categoria, opts) {
    return this.usable(this.config.categories[categoria]?.models || [], opts);
  }

  async classify(text, { previous, soloGratis, signal } = {}) {
    const names = Object.keys(this.config.categories);
    // Un messaggio breve non vale una chiamata in più.
    if (this.env.CLASSIFICATORE === 'regole' || text.length < 60) return { ...rulesClassify(text), via: 'regole' };
    for (const modelId of this.usable(this.config.routerModels, { soloGratis }).slice(0, 2)) {
      try {
        const raw = await complete({
          config: this.config,
          env: this.env,
          modelId,
          messages: classifierPrompt(this.config.categories, text, previous),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        });
        const parsed = parseClassification(raw, names);
        if (parsed) return { ...parsed, via: modelId };
      } catch (err) {
        if (signal?.aborted) throw err;
        this.report(modelId, err);
      }
    }
    return { ...rulesClassify(text), via: 'regole' };
  }

  // Mette in pausa un modello che ha dato errore e dice perché, in italiano.
  report(modelId, err) {
    const s = err.status;
    let ms, motivo;
    if (s === 429) { ms = (err.retryAfter || 60) * 1000; motivo = 'limite di richieste raggiunto'; }
    else if (s === 401 || s === 403) { ms = 10 * 60e3; motivo = 'chiave rifiutata'; }
    else if (s === 404 || (s === 400 && /model/i.test(err.message))) { ms = 60 * 60e3; motivo = 'modello non trovato (prova npm run check)'; }
    else if (s === 400 || s === 413 || s === 422) { ms = 0; motivo = 'richiesta rifiutata'; }
    else { ms = 30e3; motivo = 'fornitore non raggiungibile'; }
    if (ms) this.pauses.set(modelId, { until: this.now() + ms, motivo });
    return `${motivo}${err.message ? ` — ${err.message}` : ''}`;
  }
}
