# Cube-Atlas Cantiere — come procedere

Il **Cantiere** è un editor di mondi separato da Cube-Atlas. Mostra la mappa
2D dall'alto e permette di modificarla: biomi, copia/incolla anche tra mondi,
fusione dei bordi, pennelli del terreno, sostituzione, vegetazione, fiumi,
spawn, `level.dat`, giocatori, ricerca, potatura dei chunk. Scrive sempre su
una **copia** del mondo, e solo quando premi **Applica**.

## I due prompt
- [`PROMPT-DESIGN.md`](PROMPT-DESIGN.md) — da dare a **Claude Design**.
- [`PROMPT-SVILUPPO.md`](PROMPT-SVILUPPO.md) — da dare a una sessione di
  **Claude Code** sul repository `fruggism/FruCraft`.

## Ordine consigliato
1. **Avvia subito entrambi, in parallelo.** Le fasi 0–7 dello sviluppo
   (motore di scrittura, operazioni, test) non dipendono dal design: l'agente
   di sviluppo costruisce un'UI provvisoria con il layout giusto e tiene tutti
   i colori in un unico `tokens.css`.
2. Quando il design è pronto, **esportalo e mettilo in `editor/design/`**
   (token CSS, schermate PNG, note). Poi scrivi all'agente di sviluppo: "il
   design è in `editor/design/`, applicalo".
3. Alla fine di ogni fase l'agente aggiorna `editor/PROGRESS.md` con una
   **checklist "prova in gioco"**. Eseguila sul Mac, con Minecraft, sulla
   copia creata dal Cantiere, e rimanda all'agente quello che non va:
   screenshot e coordinate aiutano molto.
4. La fase 1 è la più importante: dimostra che il Cantiere sa scrivere un
   mondo che Minecraft apre senza errori. Conviene provarla subito, prima che
   l'agente vada avanti.

## Scelte già fatte (modificabili)
- **Electron.** Dà accesso al disco senza i limiti del browser, worker
  veri per i lavori pesanti, e una `.app` da aprire con doppio clic.
- **Stesso repository, cartella `editor/`.** Il codice di lettura dei mondi
  si riusa da `web/js/core/` invece di essere copiato.
- **Solo 1.18+**, tutte le dimensioni. Minecraft dev'essere chiuso durante
  Applica: il Cantiere lo controlla.
