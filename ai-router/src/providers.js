/*
 * Parlare con i fornitori. Quasi tutti accettano il formato di OpenAI
 * (/chat/completions); Anthropic ha il suo (/messages). Entrambi rispondono
 * in streaming (SSE), che qui diventa un generatore di pezzi di testo.
 */

export class ProviderError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// L'indirizzo base e la chiave di un fornitore, o null se non è configurato.
export function credentials(provider, env) {
  if (provider.urlEnv) {
    const url = env[provider.urlEnv];
    return url ? { baseUrl: url.replace(/\/+$/, ''), apiKey: null } : null;
  }
  const apiKey = env[provider.keyEnv];
  return apiKey ? { baseUrl: provider.baseUrl, apiKey } : null;
}

// Le righe `data:` di uno stream SSE.
export async function* sseData(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
    }
  }
  buf += decoder.decode();
  if (buf.startsWith('data:')) yield buf.slice(5).trimStart();
}

async function errorFrom(res) {
  const text = await res.text().catch(() => '');
  let message = text;
  try {
    const json = JSON.parse(text);
    const err = Array.isArray(json) ? json[0]?.error : json.error;
    message = err?.message || json.message || text;
  } catch {}
  const retryAfter = Number(res.headers.get('retry-after')) || undefined;
  return new ProviderError(res.status, (message || res.statusText).slice(0, 300), retryAfter);
}

// Il formato di Anthropic: il prompt di sistema a parte, e i turni devono
// alternarsi partendo dall'utente.
export function toAnthropic(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const out = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!out.length && m.role === 'assistant') continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  return { system, messages: out };
}

async function* openaiStream({ baseUrl, apiKey, model, messages, signal }) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  for await (const data of sseData(res.body)) {
    if (data === '[DONE]') return;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json.error) throw new ProviderError(json.error.code || 500, json.error.message || 'errore del fornitore');
    const text = json.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}

async function* anthropicStream({ baseUrl, apiKey, model, messages, maxTokens, signal }) {
  const converted = toAnthropic(messages);
  const res = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: converted.messages,
      ...(converted.system && { system: converted.system }),
    }),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  for await (const data of sseData(res.body)) {
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') yield json.delta.text;
    else if (json.type === 'error') throw new ProviderError(529, json.error?.message || 'errore del fornitore');
    else if (json.type === 'message_stop') return;
  }
}

// Pezzi di testo della risposta di `modelId`. Gli errori prima del primo pezzo
// (chiave, limiti, modello inesistente) arrivano come ProviderError.
export function streamChat({ config, env, modelId, messages, signal }) {
  const m = config.models[modelId];
  const provider = config.providers[m.provider];
  const cred = credentials(provider, env);
  if (!cred) throw new ProviderError(401, `manca la chiave di ${provider.label}`);
  const args = { ...cred, model: m.model, messages, maxTokens: config.settings.maxTokens, signal };
  return provider.type === 'anthropic' ? anthropicStream(args) : openaiStream(args);
}

// La risposta intera, per il classificatore e per il controllo dei modelli.
export async function complete(opts) {
  let text = '';
  for await (const piece of streamChat(opts)) text += piece;
  return text;
}
