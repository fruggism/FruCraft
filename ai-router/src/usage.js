/*
 * Quante richieste e quanti caratteri per modello, giorno per giorno.
 * Serve a vedere chi lavora davvero e a rispettare i `limiteGiorno`.
 */

import fs from 'node:fs';
import path from 'node:path';

function dayKey(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export class Usage {
  constructor(file) {
    this.file = file;
    this.data = {};
    if (file) {
      try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    }
  }

  today(modelId) {
    return this.data[dayKey()]?.[modelId]?.richieste || 0;
  }

  add(modelId, chars) {
    const day = (this.data[dayKey()] ||= {});
    const row = (day[modelId] ||= { richieste: 0, caratteri: 0 });
    row.richieste += 1;
    row.caratteri += chars;
    this.save();
  }

  // Gli ultimi giorni, dal più recente.
  recent(days = 30) {
    return Object.keys(this.data).sort().reverse().slice(0, days).map(day => ({ day, modelli: this.data[day] }));
  }

  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
    }, 500);
    this.timer.unref?.();
  }
}
