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

**Mondi 26.x** (i salvataggi di oggi: 1.21.9 → 26.3 hanno cambiato formato)
- **Spawn**: in `level.dat` è `Data.spawn.pos` [x, y, z], non più SpawnX/Y/Z.
  Leggerlo male dava NaN e il clic su un mondo non apriva niente.
- **Palette dei blocchi** (26.3): nomi nudi, oppure lista mista con
  `{ id, properties }`; in binario gli elementi non compound sono avvolti in
  `{ "": x }` (`nbt.js` li spacchetta e `nbtWrite.js` li riavvolge: 200 chunk
  veri riscritti identici al byte). Prima la mappa saltava le sezioni con piante
  e acqua e dall'alto si vedeva pietra grigia a quadrati. `ChunkEditor` scrive
  nel formato del chunk che modifica.
- **Cartelle**: anche l'Overworld sta in `dimensions/minecraft/overworld/`
  (`dimensionInfo(id, modern)`, `NodeSource.modernLayout`). Prima Applica non
  trovava le region e copiava il mondo senza le modifiche ai blocchi.
- **Ora, meteo, regole**: in `data/minecraft/world_clocks.dat`, `weather.dat`,
  `game_rules.dat` (regole come `minecraft:keep_inventory`, byte/int). Nuove
  operazioni `setDayTime` e `setWeather`; `setGameRule` scrive dove serve. Le
  vecchie `setLevelValue` restano valide per i giornali già salvati.

**Chiedi a Claude** (⌘K, Modifica/Mondo → *Chiedi a Claude…*, o dal pannello
della selezione)
- Si seleziona un'area (lato massimo **256** blocchi), si scrive la richiesta
  ("trasforma in una collina boscosa"), si sceglie Opus (default) o Sonnet.
- **Usa l'abbonamento Claude, non una chiave API**: l'app lancia la CLI di
  Claude Code dell'utente (`claude -p`, cercata in `~/.local/bin`,
  `/opt/homebrew/bin`, `/usr/local/bin`, … o `claudePath` in
  `settings.json`), dopo aver tolto dall'ambiente `ANTHROPIC_*` e
  `CLAUDE_CODE_*`. Prima controlla `claude auth status`: se non è collegata o
  è collegata con una chiave API lo dice e si ferma.
- **Claude non tocca niente**: `--tools ""` (nessuno strumento: non legge né
  scrive file, non esegue comandi), `--safe-mode` e `--strict-mcp-config`
  (niente hook, plugin, MCP, CLAUDE.md dell'utente),
  `--no-session-persistence`, cartella di lavoro temporanea vuota. Riceve sul
  stdin il riassunto dell'area (`editor/core/survey.js`: quota del suolo,
  blocchi in superficie, acqua, chiome degli alberi, biomi, limiti Y; griglie
  ridotte a ~64×64 celle) e risponde con una **ricetta JSON**
  (`editor/core/recipe.js`: passi di terreno — set, raise, hill, ridge,
  plateau, grid, noise, smooth, clamp, terrace — materiali, livello
  dell'acqua, raccordo coi bordi; modifiche fillBox / replace / biome; alberi
  e piante sparsi o puntuali).
- La ricetta è **validata e compilata** in un'unica operazione `group` del
  giornale: le altezze per colonna e la quota di ogni albero sono risolte
  subito, così ogni chunk si ricostruisce da solo. Il dialogo mostra la
  spiegazione di Claude e i numeri (colonne alzate/abbassate, alberi,
  piante); **Metti in sospeso** la aggiunge come **una voce sola** (⌘Z la
  toglie tutta) e la mappa si aggiorna; si scrive solo con Applica, su una
  copia. Errori di ricetta, di CLI, limite d'uso e area troppo grande sono
  messaggi in italiano; **Annulla** ferma lettura o Claude in ogni momento.
- Avanzamento: controllo → lettura dell'area (worker) → "Claude pensa /
  scrive" con secondi e caratteri → controllo della ricetta.
- Prompt e risposta delle ultime 10 richieste restano in
  `<dati dell'app>/claude/<data>/` per capire cosa è successo.
- Nuove operazioni (`editor/core/terrain.js`, con test in
  `editor/test/claude.test.js`): `setTerrain` (altezza per colonna, base64
  Int16; sopra la nuova superficie aria o acqua fino a `waterLevel`, poi
  top/filler/pietra), `placeFeatures` (querce, betulle, abeti, ciliegi,
  giungla, acacia, quercia scura/pallida, mangrovie, azalee, cespugli; erba,
  felci, fiori, piante alte; le foglie hanno la `distance` vera, quindi non
  seccano), `group`.
- Provato: test con una CLI finta (stato, ambiente senza chiave API,
  annullamento, errori, dall'area alla copia) e nell'app su una copia di
  Samarcanda (26.3): dialogo, proposta, anteprima sulla mappa, una voce in
  Cronologia, ⌘Z. **Da provare con l'account vero**: questa sessione vedeva la
  CLI "non collegata", quindi la chiamata reale a Claude non è stata fatta.
**Copia e incolla tra mondi** (fase 3, `editor/core/clips.js`, `paste.js`, `placement.js`)
- **Copia** (⌘C, Modifica → Copia): la selezione diventa un *appunto* nella
  cartella dati dell'app (`clips/<id>/`): `clip.json` più i file region ed
  entities sotto la selezione, clonati (APFS: istantaneo, niente spazio). Da lì
  in poi il mondo di origine non serve più. Pannello **Appunti**: elenco,
  Incolla, Elimina (rifiutato se un incolla in sospeso lo usa).
- **Incolla** (⌘V): un riquadro fantasma segue il cursore, clic per posare,
  Esc annulla, "Stessa posizione" lo rimette dov'era. Diventa un'operazione
  `paste` del giornale, rigiocata dall'appunto sia per l'anteprima sia in Applica.
  - *Chunk interi*: si aggancia ai chunk (spostamento multiplo di 16, quota
    invariata); arrivano blocchi, biomi, block entity, luce e heightmap così
    come sono, e può creare chunk e region dove il mondo non ne ha. L'anello
    esterno ha `isLightOn = 0` (lo rilluma il gioco). In Applica le entità e i
    POI di questo mondo sotto il pezzo spariscono e arrivano le entità
    dell'appunto, spostate e con UUID nuovi (`apply.js: pasteEntities`).
  - *Blocchi*: solo le colonne e l'intervallo Y selezionati, a qualsiasi
    spostamento anche in verticale (**Sposta Y**), con block entity e tick
    spostati, aria e biomi a scelta. Le entità non si toccano.
  - Controlli: stessa dimensione; appunto di una versione più recente del mondo
    rifiutato; più vecchia, a blocchi, solo avviso.
- La mappa: le region create da un incolla entrano nell'insieme delle region
  della dimensione, e le tile lontane senza copia vecchia si ricostruiscono in
  background.

**Terreno — raccordo dei bordi** (fase 5, `editor/core/seam.js`, strumento T)
- Sul riquadro dell'ultimo incollato o della selezione: per ogni lato scelto
  una fascia da "Fascia dentro" a "Fascia fuori" in cui il terreno segue una
  rampa smoothstep fra il suolo dentro e quello fuori, misurati sullo stesso
  punto del lato. Le misure si prendono quando si crea l'operazione (dal mondo
  con le modifiche in sospeso) e viaggiano nell'operazione (`prof`), così ogni
  chunk si applica da solo. Sopra la nuova superficie: aria (acqua sotto il
  livello del mare); sotto: erba, terra, pietra (sabbia e arenaria sott'acqua).
- **Quota minima dentro** (per non aprire una conca), **Irregolarità** (il
  confine della fascia entra ed esce di qualche blocco, rumore liscio),
  **Alberi** (densità e legno, "come quelli intorno" = il legno più tolto nel
  chunk; chioma tutta nel chunk del tronco, foglie persistenti).
- Le colonne con qualcosa di costruito restano com'erano; dove fuori non c'è
  terreno generato quel tratto si salta.
- Prova su copie di Parco degli Dei e Città Proibita: parterre e Atlante
  incollati a blocchi con Sposta Y +67 nel prato, raccordo su 4 lati, Applica
  nel worker in ~11 s (1.035 chunk).

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
  "in arrivo (fase N)". Taglia/Ruota/Specchia: fase 3 (Copia e Incolla ci sono).
- Incolla a blocchi non porta le entità; il raccordo nella fascia interna
  rifà anche vialetti di ghiaia o sabbia (sono terreno): "Fascia dentro" 0 li lascia.

- **Chiedi a Claude — limiti**: area fino a 256×256; Claude vede il terreno
  campionato (una cella ogni 2–4 blocchi oltre i 64 di lato) e non vede
  l'interno delle costruzioni. Una colonna la cui altezza cambia viene rifatta:
  quello che c'era sopra (alberi, erba, edifici) sparisce, e una chioma di un
  albero fuori dall'area può restare sospesa. Gli edifici contano come
  "suolo". Niente conversazione: per correggere si cambia la richiesta e si
  chiede di nuovo. Il risultato dipende da Claude: va sempre guardato prima di
  Applica. Serve Claude Code installato e collegato (`claude`, poi `/login`).

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
