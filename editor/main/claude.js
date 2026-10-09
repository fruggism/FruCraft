/*
 * Talking to Claude through the user's own Claude Code CLI (`claude -p`), so
 * the request runs on their Claude subscription — never on a paid API key.
 *
 * The CLI gets no tools at all (`--tools ""`): it cannot read, write or run
 * anything, it only reads the prompt on stdin and answers. It runs in an empty
 * folder of its own, without the user's hooks, plugins, MCP servers or
 * CLAUDE.md (`--safe-mode`, `--strict-mcp-config`), and without saving a
 * session. Variables that would switch it to an API key are removed from its
 * environment.
 *
 * No Electron in here: the tests drive it with a fake `claude`.
 */

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where Claude Code usually lives on a Mac (an app started from the Finder has a bare PATH). */
export function claudeCandidates(home = os.homedir()) {
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
  ];
}

const isExecutable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

/** The `claude` executable: the configured one, else the usual places, else the PATH. Null if none. */
export function findClaude(configured = null) {
  if (configured) return isExecutable(configured) ? configured : null;
  for (const p of claudeCandidates()) if (isExecutable(p)) return p;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'claude');
    if (dir && isExecutable(p)) return p;
  }
  return null;
}

/** The environment for the CLI: no API keys, no traces of a parent Claude Code session. */
export function cleanEnv(exe, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_AGENT_SDK|CLAUDE_PID$|CLAUDE_EFFORT$|AI_AGENT$)/.test(k)) continue;
    env[k] = v;
  }
  const extra = [path.dirname(exe), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  env.PATH = [...extra, ...String(base.PATH || '').split(path.delimiter).filter(Boolean)].filter((d, i, a) => a.indexOf(d) === i).join(path.delimiter);
  return env;
}

export const NOT_FOUND = 'Claude Code non è installato (o non lo trovo). Installalo da claude.com/claude-code, poi nel Terminale scrivi “claude” e accedi col tuo account.';
export const NOT_LOGGED = 'Claude Code non è collegato al tuo account. Apri il Terminale, scrivi “claude” e accedi con /login (abbonamento Pro o Max), poi riprova.';
export const API_KEY = 'Claude Code è configurato con una chiave API, che si paga a consumo. Il Cantiere usa solo l\'abbonamento: nel Terminale esegui “claude” e accedi con /login col tuo account Claude.';

/**
 * Is the CLI there and signed in with a Claude account?
 * Resolves { ok, exe, error, method }.
 */
export function claudeStatus(configured = null) {
  const exe = findClaude(configured);
  if (!exe) return Promise.resolve({ ok: false, exe: null, error: NOT_FOUND });
  return new Promise((resolve) => {
    execFile(exe, ['auth', 'status'], { env: cleanEnv(exe), timeout: 20000, cwd: os.tmpdir() }, (err, stdout) => {
      let st = null;
      try { st = JSON.parse(String(stdout).slice(String(stdout).indexOf('{'))); } catch { /* old CLI or not JSON */ }
      if (!st) {
        // Older versions have no `auth status`: let the real call tell.
        resolve({ ok: true, exe, method: 'unknown' });
        return;
      }
      if (!st.loggedIn) { resolve({ ok: false, exe, error: NOT_LOGGED }); return; }
      if (/api.?key/i.test(String(st.authMethod || ''))) { resolve({ ok: false, exe, error: API_KEY, method: st.authMethod }); return; }
      resolve({ ok: true, exe, method: st.authMethod || 'claude.ai' });
    });
  });
}

/** Arguments of the one-shot call: print mode, streaming JSON out, no tools, nothing of the user's setup. */
export function claudeArgs({ system, model }) {
  return [
    '-p',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '',
    '--strict-mcp-config',
    '--safe-mode',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
    '--system-prompt', system,
  ];
}

/** What a failed run means for the user, from the CLI's own words. */
export function explainFailure(text) {
  const t = String(text || '');
  if (/not logged in|please run \/login|invalid api key|authentication/i.test(t)) return NOT_LOGGED;
  if (/unknown option|unrecognized option/i.test(t)) return 'La versione di Claude Code è troppo vecchia per il Cantiere: nel Terminale esegui “claude update” e riprova.';
  if (/usage limit|rate limit|limit reached|quota/i.test(t)) return `Hai raggiunto il limite d'uso del tuo abbonamento Claude: riprova più tardi. (${t.trim().slice(0, 200)})`;
  if (/overloaded|529/i.test(t)) return 'Claude è sovraccarico in questo momento: riprova fra poco.';
  return t.trim().slice(0, 400) || 'Claude Code si è fermato senza dire perché.';
}

/**
 * Run the CLI once. onEvent({ phase, chars, seconds }) while it works.
 * @returns {{ promise: Promise<{ text, result }>, cancel: () => void }}
 * The promise rejects with err.cancelled = true when cancelled.
 */
export function runClaude({ exe, prompt, system, model = 'opus', cwd, onEvent = () => {}, timeoutMs = 15 * 60 * 1000 }) {
  const workDir = cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'cantiere-claude-'));
  const child = spawn(exe, claudeArgs({ system, model }), { cwd: workDir, env: cleanEnv(exe), stdio: ['pipe', 'pipe', 'pipe'] });
  let cancelled = false, timedOut = false;
  const started = Date.now();
  let chars = 0, phase = 'avvio', text = '', result = null, stderr = '', buf = '';
  const tick = () => onEvent({ phase, chars, seconds: Math.round((Date.now() - started) / 1000) });
  const timer = setInterval(tick, 1000);
  const killer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);

  const handle = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'system') { phase = 'pensa'; tick(); return; }
    if (ev.type === 'stream_event' && ev.event) {
      const d = ev.event.delta;
      if (d && d.type === 'thinking_delta') { phase = 'pensa'; }
      if (d && d.type === 'text_delta' && d.text) { phase = 'scrive'; chars += d.text.length; }
      return;
    }
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      const t = ev.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (t) text = t;
      return;
    }
    if (ev.type === 'result') result = ev;
  };

  const promise = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (err) => { clearInterval(timer); clearTimeout(killer); reject(new Error(err.code === 'ENOENT' ? NOT_FOUND : err.message)); });
    child.on('close', (code) => {
      clearInterval(timer); clearTimeout(killer);
      if (buf.trim()) handle(buf);
      if (!cwd) fs.rmSync(workDir, { recursive: true, force: true });
      if (cancelled) { reject(Object.assign(new Error('Annullato.'), { cancelled: true })); return; }
      if (timedOut) { reject(new Error('Claude ci sta mettendo troppo (oltre 15 minuti): richiesta interrotta. Prova con un\'area più piccola o una richiesta più semplice.')); return; }
      if (result && result.is_error) { reject(new Error(explainFailure(result.result || stderr))); return; }
      if (code !== 0 && !result) { reject(new Error(explainFailure(stderr || `codice d'uscita ${code}`))); return; }
      const answer = result && typeof result.result === 'string' && result.result.trim() ? result.result : text;
      if (!answer.trim()) { reject(new Error('Claude non ha risposto niente.')); return; }
      phase = 'fatto'; tick();
      resolve({ text: answer, result, seconds: Math.round((Date.now() - started) / 1000) });
    });
    child.stdin.on('error', () => { /* the CLI may close stdin early on errors */ });
    child.stdin.end(prompt);
  });
  return {
    promise,
    cancel: () => { if (child.exitCode === null) { cancelled = true; child.kill('SIGTERM'); } },
  };
}
