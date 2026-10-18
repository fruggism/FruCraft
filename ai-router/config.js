/*
 * Configurazione del router: quali fornitori, quali modelli, e per ogni tipo
 * di task in che ordine provarli. È l'unico file da toccare per cambiare
 * comportamento. Le chiavi NON vanno qui ma nel file .env.
 *
 * I nomi dei modelli cambiano spesso: se un modello non risponde più,
 * `npm run check` dice quali nomi offre oggi il fornitore.
 */

// Un fornitore è attivo solo se nel .env c'è la sua chiave (o, per Ollama,
// il suo indirizzo). Senza chiave i suoi modelli vengono semplicemente saltati.
export const providers = {
  gemini: {
    label: 'Google Gemini',
    type: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    signup: 'https://aistudio.google.com/apikey',
  },
  groq: {
    label: 'Groq',
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    signup: 'https://console.groq.com/keys',
  },
  openrouter: {
    label: 'OpenRouter',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    signup: 'https://openrouter.ai/keys',
  },
  mistral: {
    label: 'Mistral',
    type: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    signup: 'https://console.mistral.ai/api-keys',
  },
  ollama: {
    label: 'Ollama (sul tuo PC)',
    type: 'openai',
    urlEnv: 'OLLAMA_URL',
    signup: 'https://ollama.com/download',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyEnv: 'ANTHROPIC_API_KEY',
    signup: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI (GPT)',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    signup: 'https://platform.openai.com/api-keys',
  },
};

// id interno → fornitore e nome del modello presso quel fornitore.
// `free: true` = non costa nulla (piano gratuito o modello locale).
// `limiteGiorno` (facoltativo) = dopo quante richieste al giorno smettere di
// usarlo, per restare dentro il piano gratuito, es. limiteGiorno: 200.
export const models = {
  'groq-llama':     { provider: 'groq',       model: 'llama-3.3-70b-versatile',               free: true,  label: 'Llama 3.3 70B · Groq' },
  'gemini-flash':   { provider: 'gemini',     model: 'gemini-2.5-flash',                      free: true,  label: 'Gemini Flash' },
  'gemini-pro':     { provider: 'gemini',     model: 'gemini-2.5-pro',                        free: true,  label: 'Gemini Pro' },
  'mistral-small':  { provider: 'mistral',    model: 'mistral-small-latest',                  free: true,  label: 'Mistral Small' },
  'codestral':      { provider: 'mistral',    model: 'codestral-latest',                      free: true,  label: 'Codestral · Mistral' },
  'openrouter-free':{ provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', free: true,  label: 'Llama 3.3 70B · OpenRouter' },
  'ollama':         { provider: 'ollama',     model: 'llama3.2',                              free: true,  label: 'Ollama locale' },
  'claude-haiku':   { provider: 'anthropic',  model: 'claude-haiku-5-5',                      free: false, label: 'Claude Haiku' },
  'claude-sonnet':  { provider: 'anthropic',  model: 'claude-sonnet-5-5',                     free: false, label: 'Claude Sonnet' },
  'gpt-mini':       { provider: 'openai',     model: 'gpt-5-mini',                            free: false, label: 'GPT mini' },
  'gpt':            { provider: 'openai',     model: 'gpt-5',                                 free: false, label: 'GPT' },
};

// I tipi di task. Per ognuno, i modelli in ordine di preferenza: si usa il
// primo che è attivo e non ha appena dato errore. I gratuiti vengono prima,
// quelli a pagamento restano come riserva.
export const categories = {
  veloce: {
    descr: 'domande brevi, chiacchiere, definizioni, conversioni, traduzioni di poche righe',
    models: ['groq-llama', 'gemini-flash', 'mistral-small', 'openrouter-free', 'ollama', 'claude-haiku', 'gpt-mini'],
  },
  codice: {
    descr: 'scrivere, correggere, spiegare o rivedere codice, script, formule, comandi',
    models: ['gemini-pro', 'codestral', 'gemini-flash', 'openrouter-free', 'groq-llama', 'claude-sonnet', 'gpt'],
  },
  ragionamento: {
    descr: 'matematica, logica, analisi, confronti, piani e problemi in più passaggi',
    models: ['gemini-pro', 'gemini-flash', 'openrouter-free', 'groq-llama', 'claude-sonnet', 'gpt'],
  },
  scrittura: {
    descr: 'email, lettere, post, racconti, riscrivere o correggere testi',
    models: ['gemini-flash', 'mistral-small', 'groq-llama', 'openrouter-free', 'claude-sonnet', 'gpt'],
  },
  documenti: {
    descr: 'leggere, riassumere o interrogare testi molto lunghi incollati nel messaggio',
    models: ['gemini-flash', 'gemini-pro', 'claude-sonnet', 'gpt'],
  },
};

// Chi classifica il task: un modello veloce e gratuito. Se nessuno è
// disponibile, o con CLASSIFICATORE=regole nel .env, decidono le regole a
// parole chiave (gratis e istantanee, ma meno precise).
export const routerModels = ['groq-llama', 'gemini-flash', 'mistral-small', 'openrouter-free', 'ollama', 'claude-haiku', 'gpt-mini'];

export const settings = {
  systemPrompt: "Sei un assistente utile e preciso. Rispondi nella lingua dell'utente.",
  maxTokens: 4096,
};

export default { providers, models, categories, routerModels, settings };
