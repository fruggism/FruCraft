# Cantiere — stato dei lavori

Ultimo aggiornamento: fasi 0 e 1 (parziale), vedi sotto.

## Cosa funziona

**Fase 0 — scheletro**
- App Electron (`npm run cantiere`): barra dei menu a schede con ribbon, schede
  dei mondi (una per mondo, pallino se ci sono modifiche in sospeso, × per
  chiudere), colonna strumenti, barra opzioni, pannello destro
  (Proprietà / Appunti / Cronologia / Risultati), barra di stato.
- Schermata vuota con l'elenco dei mondi trovati in
  `~/Library/Application Support/minecraft/saves` (cartella cambiabile da
  Impostazioni).
- Mappa 2D: Leaflet + `web/js/core/tiler.js` (la stessa di Cube-Atlas),
  attraverso un `OverlaySource` che ci mette sopra le modifiche in sospeso.
- Slider della **quota di taglio** (Vista → Taglio orizzontale, o nella barra
  di stato): nuova opzione `maxY` in `analyzeChunk`/`readSurface`/`renderBaseTile`
  (default: nessun limite, `web/` non cambia).
- Tutti i colori e le misure stanno in `editor/renderer/tokens.css`.

**Fase 1 — fondamenta di scrittura**
- `web/js/core/nbtWrite.js`: writer NBT condiviso (browser e Node) e lettura
  "tipizzata" (`parse(bytes, { typed: true })`) che conserva Byte/Short/Float/
  Double e il tipo delle liste vuote: un albero riletto si riscrive identico
  byte per byte. `test/nbt-write.js` ora lo riusa.
- `editor/core/region.js`: lettura e scrittura `.mca`, settori da 4 KiB,
  chunk non toccati copiati senza ricomprimerli, chunk oltre 1 MiB in `.mcc`,
  scrittura atomica (file temporaneo + rename).
- `editor/core/chunk.js`: `ChunkEditor` — palette e packing (a blocchi per
  DataVersion ≥ 2529, a tratti prima), `setState`/`setBiome`, e al commit:
  luce tolta dalle sezioni toccate + `isLightOn: 0`, heightmap ricalcolate,
  block entity e tick dei blocchi sostituiti rimossi. Chiavi sconosciute intatte.
- `editor/core/journal.js`: giornale di operazioni (JSON), Annulla/Ripeti.
  Operazioni oggi: `setSpawn`, `setGameRule`, `setLevelValue` (ora, meteo, …),
  `fillBox` (riempie una scatola: serve a provare la catena dei chunk).
- `editor/core/apply.js`: **Applica sempre su una copia** (`<Nome> (Cantiere)`,
  poi `(Cantiere 2)`, …) con clonazione copy-on-write, controlli preliminari
  (versione ≥ 1.18.2, `session.lock` via `lsof`, spazio su disco), marcatore di
  incompleto, riscrittura delle region, **verifica per rilettura**.
- Spawn + `level.dat` (§5.10): spawn con clic sulla mappa o coordinate, ora del
  giorno (anche preset), meteo, tabella delle gamerule. Il giornale si salva su
  disco a ogni modifica e **sopravvive a un crash** (cartella dati dell'app).
- Test (`npm test`, sezioni "Cantiere"): round-trip NBT/region/chunk, byte
  dell'originale identici dopo Applica, giornale, anteprima, sessione.

## Cosa manca / scelte da conoscere
- **Worker.** Applica oggi scrive le region nel processo principale, con
  avanzamento per file. Va spostato in `worker_threads` con annullamento
  quando arrivano le operazioni pesanti (fase 2+).
- **Cache delle tile.** Dopo ogni modifica si svuota tutta la cache; più
  avanti si invalideranno solo le tile dei chunk toccati.
- **POI ed `entities/`.** Le operazioni sui blocchi non toccano ancora `poi/` né
  `entities/`: un `fillBox` sopra un letto o un portale può lasciare un POI
  orfano. Da fare con le fasi 2–3.
- **Heightmap:** ricalcolate con un elenco di nomi di blocchi "attraversabili"
  (il salvataggio non contiene le proprietà dei blocchi del gioco): può sbagliare
  di un blocco sopra le decorazioni. `commit({ heightmaps: 'drop' })` le toglie
  e le lascia ricostruire al gioco — **da verificare in gioco quale delle due
  vie è meglio** (vedi checklist).
- **Mondi non-Overworld:** la lista delle dimensioni viene da `scanWorld`;
  altezza e cartelle sono in `editor/core/dimensions.js` (custom: default
  overworld).
- Strumenti disabilitati nella colonna: arrivano nelle fasi indicate.
- Nessuna firma dell'app: aprirla con tasto destro → Apri.

## Dipendenze
- `electron` — l'app. `electron-builder` — `npm run cantiere:build` crea
  `dmg`/`zip` (arm64 e x64). Sono `devDependencies`; nient'altro.

## Checklist "prova in gioco" — fase 1
Sul Mac, con Minecraft **chiuso**, su un mondo 1.18.2 o successivo (meglio una
copia di prova):
1. `npm install && npm run cantiere`. Dovresti vedere i tuoi mondi in elenco.
2. Apri un mondo. Verifica che la mappa assomigli a quella di Cube-Atlas.
3. Strumento **Spawn**: clicca un punto della mappa. Compare il pallino rosso e
   in basso "1 modifica in sospeso". Cambia anche **ora del giorno** (Mezzanotte),
   **meteo** (Temporale) e una gamerule (es. `keepInventory`).
4. **Applica**: controlla che il nome proposto sia `<Nome> (Cantiere)` e premi
   Applica. Il mondo originale non deve essere cambiato (data di modifica dei
   file invariata).
5. Apri Minecraft: la copia `<Nome> (Cantiere)` compare nell'elenco.
   - Entra: **nessun errore** all'apertura, e se hai spostato lo spawn,
     creando un nuovo giocatore o con `/spawnpoint`/`/tp @s ~ ~ ~` dopo la
     morte sullo spawn del mondo, finisci dove hai cliccato.
   - Ora del giorno, meteo e gamerule sono quelli impostati (`/gamerule keepInventory`).
6. **Prova delle region (fillBox):** non c'è ancora un pulsante; per provarlo
   senza UI, da una console di Node:
   ```js
   // nella cartella del repo
   // node --input-type=module -e "…"  (vedi editor/test/cantiere.test.js, test "Applica scrive una copia")
   ```
   Applica un `fillBox` di `gold_block` sotto lo spawn su una copia di prova e
   verifica in gioco: il blocco c'è, **la luce si ricalcola** (niente zone
   nere/illuminate a caso), non ci sono errori nel log, i chunk vicini sono
   intatti. Annota se le **heightmap** sembrano giuste (pioggia, mob sopra il
   terreno) per decidere fra `recompute` e `drop`.
7. Se il Cantiere si chiude a metà modifiche, riaprilo: le modifiche in sospeso
   devono ricomparire (Cronologia).
