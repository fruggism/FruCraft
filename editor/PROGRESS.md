# Cantiere — stato dei lavori

Ultimo aggiornamento: **design applicato + fase 2** (selezioni, biomi,
sostituzione, ricerca), sopra le fasi 0 e 1.

## Cosa funziona

**Fasi 0 e 1 — scheletro e scrittura** (vedi la storia di questo file per i
dettagli): app Electron, schede dei mondi, mappa 2D di Cube-Atlas con le
modifiche in sospeso sopra, quota di taglio, writer NBT/region, editor di
chunk, giornale con Annulla/Ripeti che sopravvive a un crash, **Applica sempre
su una copia** con verifica per rilettura, spawn/ora/meteo/regole di gioco.

**Design approvato** (`editor/design/`, applicato a tutta l'interfaccia)
- `editor/renderer/tokens.css` è quello del design (tema scuro e chiaro, più
  "come il sistema" dalle Impostazioni). Le icone pixel art del design sono uno
  sprite dentro `index.html`.
- Barra dei menu con i semafori di macOS integrati (`titleBarStyle:
  hiddenInset`) e la pastiglia "Originale intatto"; ribbon con icona + testo e
  scorciatoie nei tooltip; schede dei mondi con icona della dimensione e
  pallino ambra; barra opzioni per strumento; colonna strumenti a gruppi
  (comprimibile con ⌘\, e da sola sotto 1180 px); pannello destro
  (Proprietà / Appunti / Cronologia / Risultati, nascondibile con ⌘⌥\); barra
  di stato con coordinate, blocco · bioma, chunk/region, zoom, quota di
  taglio, modifiche in sospeso e Applica.
- Schermata di Avvio con l'immagine del mondo (`icon.png` del gioco),
  versione, dimensioni e mondi troppo vecchi in sola lettura.
- Dialogo Applica come da design: nome della copia, riepilogo, controlli ✓/✕
  (versione, Minecraft chiuso, spazio su disco, originale in sola lettura),
  avanzamento con **Annulla** (la copia incompleta viene rimossa), "Copia
  creata" → Apri la copia / Mostra nel Finder.
- Le schermate non disegnate (pannello spawn/level.dat, ricerca, menu
  Sviluppo) usano gli stessi componenti.

**Fase 2**
- **Selezioni** (`editor/core/selection.js`): rettangolo (M), poligono (P:
  clic per i vertici, doppio clic/↩/clic sul primo per chiudere), lazo (L),
  pennello (S, dimensione con lo slider o con [ e ]). Modalità Nuova /
  Aggiungi (⇧) / Sottrai (⌥) / Interseca. Intervallo Y o tutta la colonna,
  anche "Y dalla quota di taglio". Seleziona tutto ⌘A, Deseleziona ⌘D,
  Inverti ⇧⌘I. Selezioni salvate per mondo. Misure nel pannello (dimensioni,
  colonne, blocchi, chunk toccati). La selezione si valuta un chunk alla volta:
  regge migliaia di blocchi per lato (test: 6000×6000).
- **Biomi**: pennello (B) con selettore cercabile e colori; se c'è una
  selezione, il pennello resta dentro. "Riempi la selezione". Si dipingono
  celle 4×4×4 intere, solo il bioma (i blocchi restano), senza creare sezioni.
  **Vista biomi** della mappa (Vista → Vista biomi).
- **Sostituisci** (R, o dal menu): dialogo del design con regole A → B; A è un
  blocco, un blocco con proprietà (`oak_stairs[half=top]`), un tag
  (`#minecraft:logs`, tabella in `editor/core/blocks.js`) o un pattern
  (`*_planks`); B un blocco o un mix (`70% stone, 30% andesite`, scelto in modo
  deterministico per posizione: l'anteprima è quello che verrà scritto).
  Filtri: Y, solo esposti all'aria, biomi. "Mantieni proprietà" nella stessa
  famiglia (scale → scale, tronchi → tronchi). Conteggio esatto in anteprima,
  calcolato in un worker, con quanti blocchi perdono le proprietà. Senza
  selezione vale per tutta la dimensione (lo dice il dialogo).
- **Cerca** (F / ⌘F): blocco/tag/pattern; contenuti (block entity per tipo,
  oggetto contenuto anche annidato, testo di cartelli e nomi); entità (dalla
  cartella `entities/`). Nella selezione o in tutta la dimensione, con le
  modifiche in sospeso incluse. Totale esatto, elenco dei primi 2.000,
  sulla mappa anelli (pochi risultati) o una mappa di calore per chunk (molti);
  clic su un risultato → ci va. Esporta CSV.
- **Worker** (`editor/workers/task.js`, `editor/main/tasks.js`): Applica,
  ricerca e conteggio della sostituzione girano fuori dal processo principale,
  con avanzamento e annullamento.
- **Mappa più reattiva**: dopo una modifica si ridisegnano solo le tile dei
  chunk toccati. Da lontano (zoom ≤ −2) si mostra il riquadro vecchio finché
  quello nuovo non è ricostruito in background: niente buchi.
- **Cronologia**: ogni modifica con colore, descrizione e "quanto tempo fa";
  ↶ toglie una singola modifica anche in mezzo alla lista.
- **Menu Sviluppo** (Impostazioni → Menu Sviluppo): "Riempi area con
  blocco…", per provare la scrittura delle region senza console, con la scelta
  heightmap "Ricalcola il Cantiere" / "Lascia fare al gioco".

**Correzioni**
- La cache delle region di `web/js/core/anvil.js` ora distingue i mondi: con
  due mondi aperti, `region/r.0.0.mca` di uno non veniva più scambiato con
  quello dell'altro. Retrocompatibile per `web/`.
- Versione minima: il controllo era già DataVersion 2860 = **1.18**, ma i
  messaggi dicevano "1.18.2". Ora dicono 1.18.

## Cosa manca / scelte da conoscere
- **"Solo esposti all'aria"** guarda i vicini dentro lo stesso chunk: sul
  bordo di un chunk un blocco con aria solo nel chunk accanto non conta come
  esposto. Da migliorare quando arriva il motore del terreno (fase 5).
- **Tag**: la tabella dei tag è scritta a mano (i tag veri stanno nel `.jar`):
  copre i più usati, un tag sconosciuto viene segnalato in rosso.
- **POI ed `entities/`**: le operazioni sui blocchi non li toccano ancora (fase 3).
- **Heightmap**: resta da decidere in gioco fra `recompute` (default) e `drop`
  — ora si prova dal menu Sviluppo.
- Le selezioni salvate stanno nel `localStorage` della finestra (per mondo);
  passeranno nella libreria degli Appunti (fase 4).
- Strumenti delle fasi successive: visibili ma disabilitati, col tooltip
  "in arrivo (fase N)". Taglia/Copia/Incolla/Ruota/Specchia: fase 3.

## Dipendenze
- `electron`, `electron-builder` (devDependencies). Nient'altro.
- Build: `asar` disattivato, perché i worker si caricano da file veri; il
  pacchetto esclude `editor/design/` ed `editor/test/`.

## Come si prova senza toccare i propri mondi
`CANTIERE_SAVES_DIR=/percorso/saves CANTIERE_DATA_DIR=/percorso/dati npm run cantiere`
usa una cartella saves e una cartella dati a parte.

## Checklist "prova in gioco" — fase 1 (scrittura) + fase 2
Sul Mac, con Minecraft **chiuso**, su una copia di prova di un mondo 1.18+:

1. `git pull`, poi `npm install && npm run cantiere`. Nella schermata di avvio
   vedi i tuoi mondi con l'immagine, la versione e la data.
2. Apri un mondo. La mappa deve assomigliare a quella di Cube-Atlas.
3. **Spawn e level.dat** — strumento Spawn: clicca un punto; Proprietà: ora
   "Mezzanotte", meteo "Temporale", una regola (es. `keepInventory`).
4. **Prova delle region** — Impostazioni → *Menu Sviluppo*, poi Sviluppo →
   *Riempi area con blocco…*: `gold_block`, 3×3 sotto lo spawn, heightmap
   **Ricalcola**. Metti in sospeso.
5. **Applica** (⌘↩): controlla nome, riepilogo e i quattro ✓, poi "Crea la
   copia e applica". L'originale non deve cambiare (data dei file invariata).
6. In Minecraft apri `<Nome> (Cantiere)`:
   - nessun errore all'apertura;
   - spawn, ora, meteo e regola come impostati;
   - l'oro c'è; **la luce è giusta** (niente zone nere o illuminate a caso);
     i chunk vicini sono intatti; pioggia/neve si fermano sopra l'oro e i mob
     ci camminano sopra (heightmap).
7. Ripeti il punto 4 con **Lascia fare al gioco** su un'altra copia e confronta
   le heightmap: dimmi quale delle due va meglio.
8. **Sostituisci**: seleziona un'area (M), R, regola `grass_block` →
   `70% moss_block, 30% podzol`, Metti in sospeso. La mappa cambia subito solo
   lì. Applica e controlla in gioco: muschio e podzol mescolati, nessun buco,
   luce giusta.
9. **Mantieni proprietà**: in una zona con scale di quercia, `oak_stairs` →
   `spruce_stairs`: in gioco le scale devono restare girate come prima.
10. **Biomi**: B, scegli *Deserto*, dipingi una striscia. In gioco (F3) il
    bioma lì è deserto, l'erba ha il colore del deserto, i blocchi sono gli
    stessi. Vista → Vista biomi deve mostrare la striscia.
11. **Cerca**: F, `diamond_ore` (o `#minecraft:diamond_ores`) in tutta la
    dimensione; poi Contenuto → Contiene `diamond`. Vai su un risultato e
    controlla in gioco che ci sia davvero.
12. **Più mondi**: apri due mondi insieme, passa da una scheda all'altra: le
    mappe non si mescolano.
13. Chiudi il Cantiere con modifiche in sospeso e riaprilo: devono ricomparire
    (Cronologia).
