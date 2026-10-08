# Prompt per l'agente di sviluppo — Cube-Atlas **Cantiere**

> Copia tutto quello che c'è sotto la riga in una nuova sessione di Claude Code
> aperta sul repository `fruggism/FruCraft`.

---

Sei l'agente di sviluppo di **Cube-Atlas Cantiere**, un editor di mondi
Minecraft Java Edition per macOS. Vive nello stesso repository di Cube-Atlas
(`fruggism/FruCraft`), ma è un'**app separata**. Lavora su un tuo branch
(`editor/cantiere`, o quello che ti viene assegnato), fai commit piccoli e
frequenti e fai push alla fine di ogni fase.

## 1. Cosa esiste già e cosa devi riusare

Cube-Atlas (`web/`) è un'app browser che **legge** i mondi e ne disegna la
mappa 2D vista dall'alto. Prima di scrivere codice leggi il `README.md` e
questi moduli:

- `web/js/core/nbt.js` — parser NBT (gzip/zlib/non compresso).
- `web/js/core/anvil.js` — lettura dei file `.mca`, `normalizeChunk`, palette,
  packing (con padding e senza), biomi 1.18+, `readSurface`.
- `web/js/core/source.js` — astrazione `WorldSource` (cartella → byte).
- `web/js/core/tiler.js`, `renderJob.js`, `blockColors.js` — piramide di tile
  RGBA 256×256, colori dei blocchi, ombreggiatura. **La mappa 2D dell'editor
  deve essere questa**, non una nuova.
- `web/js/core/worldScan.js` — scansione di regioni e chunk.
- `web/js/voxel/blockKinds.js` — classificazione delle forme dei blocchi.
- `test/nbt-write.js` — **scrittore NBT** che oggi serve solo alle fixture.
  Va promosso a modulo condiviso (`web/js/core/nbtWrite.js` o
  `editor/core/…`), con test di round-trip.
- `test/node-source.js`, `test/make-test-world.js`,
  `test/make-showcase-world.js` — sorgente su filesystem e generatori di mondi
  sintetici: sono la base dei tuoi test.

Regole per il codice condiviso:

- Il core è già un insieme di ES module puri che girano in Node (lo fa la
  test suite): **importali, non copiarli**.
- Se devi cambiare qualcosa in `web/js/core/`, fallo in modo retrocompatibile.
  `npm test` deve restare verde e l'Atlante 2D/3D non deve accorgersene.
- Non toccare l'UI di `web/`.

## 2. Vincoli non negoziabili

1. **L'originale non si scrive mai.** "Applica" scrive sempre in una **copia**
   del mondo, dentro la stessa cartella `saves/` (nome di default
   `<NomeMondo> (Cantiere)`, poi `(Cantiere 2)`, … ; modificabile prima di
   confermare). Se si sta già lavorando su una copia creata dal Cantiere, lo
   si può riscrivere, ma solo dopo aver mostrato una conferma esplicita.
   - Il file sorgente si apre solo in lettura (`fs.open(..., 'r')`).
   - Aggiungi un test che verifica che, dopo un Applica, i byte del mondo
     originale siano identici a prima.
2. **Le modifiche restano in sospeso finché non premi Applica.** Ogni
   operazione va in un **giornale** (journal) in memoria e su disco, in una
   cartella dati dell'app, così le modifiche non applicate sopravvivono a un
   crash. La mappa mostra l'anteprima: il mondo letto con sopra le modifiche
   in sospeso. Annulla/Ripeti lavorano sul giornale.
3. **Minecraft dev'essere chiuso.**
   - Prima di Applica, controlla `session.lock` sia sull'originale sia sulla
     copia: se il lock è tenuto, blocca e spiega perché.
   - Avvisa anche se il `level.dat` dell'originale cambia mentre il mondo è
     aperto nel Cantiere.
4. **Solo versioni 1.18+** (DataVersion ≥ 2860). Un mondo più vecchio si apre
   in sola lettura, con un messaggio chiaro.
5. **Tutte le dimensioni:** Overworld (`region/`), Nether (`DIM-1/region/`),
   End (`DIM1/region/`), più quelle custom sotto `dimensions/<ns>/<nome>/`.
   - L'altezza va letta dai dati, non scritta nel codice: −64..320 nel
     vanilla, 0..256 nel Nether.
   - Ogni dimensione ha anche `entities/` e `poi/`.
6. **Non si perde nessun dato che non capisci.** Le chiavi NBT sconosciute
   (mod, `structures`, `PostProcessing`, `blending_data`, …) vanno ripassate
   intatte. Un chunk letto e riscritto senza modifiche deve essere
   **semanticamente identico**: c'è un test di round-trip su ogni fixture.
7. **Deve girare sul MacBook dell'utente** (macOS recente; considera sia Apple
   Silicon sia Intel), offline, senza account e senza server remoti.
8. **Scala:** le selezioni possono essere di **migliaia di blocchi per lato**.
   - Niente array densi dell'intero volume: lavora per chunk e per sezioni
     16³ con palette.
   - Il lavoro pesante va nei worker (`worker_threads`), in streaming, con
     barra di avanzamento e possibilità di annullare.
   - Tieni sotto controllo la memoria: un'operazione su 4000×4000 colonne
     non deve superare qualche GB.

## 3. Architettura

- **Electron** (main process Node + renderer). Esegue Node vero (fs, zlib,
  worker_threads), quindi può scrivere su disco senza i limiti del browser, e
  produce una vera `.app`.
  - Pacchettizza con `electron-builder` per `dmg`/`zip` (arm64 e x64).
  - L'app non è firmata, quindi documenta l'apertura con tasto destro → Apri.
- Comandi:
  - `npm run cantiere` — avvia in sviluppo;
  - `npm run cantiere:build` — crea la `.app`;
  - `npm test` — deve includere anche i test del Cantiere.
- Cartelle:
  - `editor/main/` — processo principale: finestre, accesso al disco,
    giornale, Applica.
  - `editor/core/` — logica pura, testabile in Node: scrittura region,
    serializzazione dei chunk, trasformazioni, operazioni.
  - `editor/workers/` — lavori pesanti.
  - `editor/renderer/` — UI.
  - `editor/test/` — test.
- **Comunicazione:** il renderer non tocca mai il filesystem. Parla con il main
  via IPC con un'API piccola e tipizzata, esposta da `contextBridge`, con
  `contextIsolation` attivo e `nodeIntegration` disattivato.
- **Mappa:** Leaflet con `CRS.Simple`, come in `web/` (copia o importa
  `web/vendor/leaflet.js`), più un livello canvas per selezioni, pennelli e
  anteprime.
  - Le tile si generano con `tiler.js` passando per l'overlay delle modifiche.
  - Quando un chunk cambia, si invalidano solo le tile che lo coprono, a tutti
    gli zoom.
- **Vista a quota (taglio orizzontale):** uno slider Y imposta la quota
  massima visibile, e la mappa disegna la superficie *sotto* quel piano (come
  un taglio). Serve a vedere grotte, interni, il Nether sotto il tetto di
  bedrock, e a impostare i volumi. Estendi `readSurface`/`analyzeChunk` con
  un'opzione `maxY` (default: nessun limite, così `web/` non cambia).
- **Scrittura region:** serve un writer `.mca` completo.
  - Header di 8 KiB con posizioni e timestamp.
  - Allocazione dei settori da 4 KiB e compressione zlib (tipo 2).
  - Supporto ai chunk "oversized" `.mcc` in lettura e scrittura.
  - Riscrittura **atomica**: file temporaneo + rename.
- **Serializzazione dei chunk modificati:**
  - Ricostruisci palette e `data` per sezione con il packing giusto per la
    DataVersion, per blocchi e biomi.
  - **Heightmaps:** ricalcolale (`MOTION_BLOCKING`, `MOTION_BLOCKING_NO_LEAVES`,
    `OCEAN_FLOOR`, `WORLD_SURFACE`).
  - **Luce:** togli `SkyLight`/`BlockLight` dalle sezioni toccate e metti
    `isLightOn: 0`, così il gioco ricalcola la luce al caricamento. Verifica
    che sia il comportamento corretto per le versioni supportate e documentalo.
  - **Tick:** sposta o elimina `block_ticks`/`fluid_ticks` coerentemente con i
    blocchi.
  - **Block entity:** riscrivi `block_entities` con le coordinate assolute
    nuove.
  - **POI:** invalida le voci `poi/` dei chunk toccati (letti, portali, …),
    togliendo la sezione interessata in modo che il gioco la ricostruisca.
    Verifica e documenta.
  - **Entità:** si salvano nei region di `entities/` (1.17+). Quando incolli,
    rigenera gli `UUID`, trasla `Pos` e, per item frame, quadri e simili,
    anche `TileX/Y/Z`. Rimuovi i riferimenti a leash, passeggeri e
    proprietari se il bersaglio non è nella porzione.
- **Versioni diverse tra sorgente e destinazione** (incolla da un altro mondo):
  - se la DataVersion sorgente è **più nuova** della destinazione, blocca;
  - se è più vecchia di molto, avvisa;
  - se un blocco non esiste nella destinazione (per quanto puoi sapere),
    segnalalo nell'anteprima.

## 4. Interfaccia (disegnata a parte)

Il design arriva da un agente Claude Design: i file di consegna (token, schermate,
note) vengono messi in `editor/design/`. Se quando inizi non ci sono ancora,
costruisci un'UI funzionale con **questo layout** e metti tutti i colori e le
misure in un unico `editor/renderer/tokens.css`, così si potrà sostituire
senza riscrivere nulla:

- **In alto, prima riga — barra a schede delle impostazioni/menu:** File,
  Modifica, Selezione, Mondo, Vista, Impostazioni. Ogni scheda apre una
  striscia di comandi, in stile ribbon leggero.
- **In alto, seconda riga — una scheda per ogni mondo aperto**, come i
  documenti di Photoshop: nome, dimensione attiva, pallino se ci sono
  modifiche in sospeso, × per chiudere. Si possono tenere aperti più mondi
  insieme, ed è necessario per il copia/incolla tra mondi.
- **Sinistra — colonna strumenti con icona + testo:** Sposta/Naviga,
  Selezione (rettangolo, poligono, lazo, pennello), Pennello bioma, Pennelli
  terreno, Vegetazione, Fiume/Lago, Sostituisci, Spawn, Cerca, Pota chunk,
  Giocatori.
- **Sotto la barra in alto — barra opzioni contestuale** dello strumento
  attivo: dimensione del pennello, quota Y min/max, bioma, ecc.
- **Destra — pannello comprimibile** con le schede Proprietà, Appunti,
  Cronologia, Risultati.
- **In basso — barra di stato:** coordinate e quota sotto il cursore, blocco e
  bioma, chunk/region, zoom, slider della quota di taglio, numero di modifiche
  in sospeso e pulsante **Applica**.
- **Schermata vuota:** "Apri un mondo", con l'elenco dei mondi trovati in
  `~/Library/Application Support/minecraft/saves` (cartella configurabile
  nelle Impostazioni).
- Lingua dell'UI: **italiano**. Scorciatoie da tastiera alla Mac:
  - ⌘O apre un mondo, ⌘W chiude la scheda;
  - ⌘Z / ⇧⌘Z annullano e ripetono;
  - ⌘X / ⌘C / ⌘V tagliano, copiano e incollano;
  - R ruota, ⇧H e ⇧V specchiano in orizzontale e in verticale;
  - B è il pennello, M la selezione, Spazio+trascina sposta la mappa;
  - ⌘↩ applica.

## 5. Funzionalità

Ogni funzionalità produce operazioni nel giornale, ha un'anteprima sulla mappa
ed è annullabile.

### 5.1 Selezione
- Rettangolo, poligono, lazo e pennello (aggiungi con ⇧, sottrai con ⌥).
- Ogni selezione ha un **intervallo Y**: tutta la colonna per default, oppure
  min/max impostati dalla barra opzioni o "dalla quota di taglio attuale".
- Mostra le dimensioni e il numero di blocchi. Una selezione si può salvare e
  ricaricare per nome.

### 5.2 Biomi (ridipingere)
- Pennello a mano libera e "riempi selezione" con un bioma scelto da un elenco
  cercabile, con colore e icona. L'elenco cambia in base alla dimensione e
  include i biomi custom trovati nel mondo.
- Rispetta la griglia 4×4×4 dei biomi 1.18+.
- Opzione "tutta la colonna" (default) oppure solo nell'intervallo Y.
- Si ridipinge solo il bioma: i blocchi non cambiano.
- Vista mappa "Biomi" (colori per bioma) attivabile dalla scheda Vista.

### 5.3 Taglia / Copia / Incolla
- **Copia** prende tutto quello che c'è nella selezione e nell'intervallo Y:
  blocchi con stato, block entity (contenuto dei bauli, cartelli, spawner…),
  entità (animali, item frame, armor stand, ecc.), biomi e tick in sospeso.
- **Taglia** = copia + riempi di aria. Sotto il livello del mare, offri
  l'opzione "riempi d'acqua dove c'era acqua attorno".
- **Incolla** mostra un fantasma sulla mappa che si trascina. Si può:
  - ruotare di 90/180/270°;
  - specchiare su X o su Z;
  - spostare in Y (offset o "appoggia sul terreno");
  - scegliere se l'aria incollata sovrascrive o no ("incolla aria");
  - scegliere se portare entità e biomi;
  - confermare con ↩.
- **Rotazione e specchio devono trasformare gli stati dei blocchi**, non solo
  le posizioni:
  - `facing`, `axis`, `rotation` 0–15 (cartelli, teste, stendardi);
  - collegamenti `north/east/south/west` (recinti, muri, pannelli, redstone);
  - `shape` delle rotaie, comprese quelle in salita;
  - `shape` delle scale (inner/outer left/right, che si scambiano nello
    specchio);
  - `hinge` delle porte, `type` dei bauli doppi (left/right);
  - `orientation` di jigsaw e crafter, `face` dei pulsanti;
  - rotazione e direzione delle entità (`Rotation`, `Facing` degli item
    frame).

  Fai una tabella guidata dai dati e testa ogni famiglia con un giro completo
  (4 rotazioni = identità, 2 specchi = identità).
- **Tra mondi diversi:** copi in una scheda, incolli in un'altra, anche tra
  dimensioni diverse.

### 5.4 Appunti salvati e schematiche
- Libreria persistente nella cartella dati dell'app, con nome, anteprima
  dall'alto, dimensioni, mondo e DataVersion di origine e tag liberi. Si
  trascina sulla mappa per incollare.
- Formato interno: compatto e basato sulle sezioni, per esempio un file NBT
  compresso con le sezioni e le palette.
- **Import ed export:**
  - `.schem` Sponge v2 e v3 (WorldEdit / FAWE), entità incluse;
  - `.nbt` dei blocchi struttura (avvisa che sono limitati a 48³ se superati);
  - `.litematic` (Litematica) come import/export opzionale, a fine lista.
- Test di round-trip per ogni formato.

### 5.5 Fusione dei bordi (dopo un incolla, opzionale)
Obiettivo: il pezzo incollato si deve fondere **con naturalezza** nel
paesaggio, modificando una **fascia di terreno naturale attorno** al pezzo.
Le costruzioni non si toccano.

- **Parametri** (con valori di default sensati e anteprima):
  - larghezza della fascia (default 12 blocchi);
  - intensità;
  - rumore/irregolarità;
  - "lato": solo l'esterno (default), oppure anche il bordo interno del
    pezzo;
  - seme casuale, con un pulsante "rimescola".
- **Altezza:** prendi la heightmap del bordo del pezzo e quella del terreno
  oltre la fascia. Nella fascia interpola con una curva morbida (smoothstep)
  pesata sulla distanza dal bordo, più rumore a bassa frequenza (simplex o
  value noise) perché il raccordo non sia una rampa geometrica.
  - Dove il terreno deve salire: riempi con i materiali giusti.
  - Dove deve scendere: scava, lasciando la stratificazione corretta.
- **Materiali vari e naturali:** gli strati superficiali (top, 3–4 blocchi di
  sub-superficie, poi pietra/deepslate) si scelgono mescolando quelli del
  pezzo e quelli del dintorno.
  - Il mix cambia in modo graduale con la distanza e ha un rumore di
    dithering, così il confine non è netto.
  - Le tavolozze dipendono dal bioma: erba/terra/terra grossolana/podzol/
    muschio nella foresta, sabbia/arenaria nel deserto, ghiaia/pietra in
    montagna, neve/terra innevata nelle zone fredde, ecc. Mettile in una
    tabella dati estendibile.
- **Acqua:** fiumi e mari che arrivano al bordo si raccordano.
  - Il livello dell'acqua viene propagato con un flood fill limitato.
  - Le sponde vengono rifinite con sabbia, ghiaia o argilla.
  - L'acqua non deve mai restare sospesa senza contenimento.
- **Vegetazione:** gli alberi tagliati dal bordo (tronchi o chiome
  interrotti) vengono rimossi interi. Poi, se l'opzione è attiva, la fascia
  viene ripopolata con erba alta, fiori e qualche albero adatto al bioma (usa
  il modulo vegetazione del §5.8).
- **Protezione delle costruzioni:**
  - Classifica i blocchi in **naturali**: pietre, terre, sabbie, ghiaie,
    minerali, acqua, lava, neve e ghiaccio, piante, foglie, tronchi *solo se
    fanno parte di un albero*, funghi giganti, ecc. Tutti gli altri sono
    **artificiali**: assi, mattoni, vetro, lastre, scale, porte, rotaie,
    blocchi da redstone, contenitori, letti, torce, lanterne, ecc.
  - Una colonna con blocchi artificiali entro un margine (default 3 blocchi)
    è **protetta** e non viene toccata. La fusione sfuma *attorno* alla
    protezione.
  - L'utente può anche dipingere a mano una **maschera di protezione**.
  - Le zone protette si vedono nell'anteprima.
- Tutto è un'unica operazione nel giornale, con anteprima prima della
  conferma.

### 5.6 Pennelli del terreno (indipendenti)
- **Leviga (smooth):** media pesata gaussiana della heightmap, con un
  materiale coerente con il dintorno.
- **Alza / Abbassa**, **Spiana** (alla quota del primo clic o a una Y
  scelta), **Erodi** (erosione termica semplice, che ammorbidisce i dirupi).
- Parametri: dimensione, intensità, morbidezza del bordo.
- Rispettano la protezione delle costruzioni e usano lo stesso motore della
  fusione dei bordi.

### 5.7 Sostituzione in blocco
- Regole "A → B", anche più di una alla volta.
  - A può essere un blocco, un tag (`#minecraft:logs`) o un pattern
    (`*_planks`).
  - B può essere un blocco o un **mix pesato**
    (`70% stone, 20% andesite, 10% tuff`).
- **Filtri:** selezione o tutta la dimensione, intervallo Y, "solo blocchi
  esposti all'aria", "solo in certi biomi".
- **Mantieni le proprietà** compatibili: `oak_stairs[facing=east,half=top]`
  diventa `spruce_stairs[facing=east,half=top]`. Le proprietà che non
  esistono in B si scartano, segnalandolo.
- Prima di confermare mostra il conteggio dei blocchi coinvolti.

### 5.8 Vegetazione
- Il pennello **pianta** alberi (generatori procedurali semplici per
  quercia, betulla, abete, giungla, acacia, quercia scura, ciliegio,
  mangrovia), fiori, erba alta e felci, con una densità.
  - La specie si sceglie a mano oppure "secondo il bioma".
  - Le piante si appoggiano solo su terreno valido.
- Il pennello **rimuovi** toglie alberi interi (tronco + chiome collegate),
  erba e fiori.

### 5.9 Fiumi e laghi
- **Fiume:** disegni una polilinea sulla mappa con larghezza e profondità.
  - Scava un letto con profilo arrotondato e una pendenza che non risale
    mai.
  - Riempie d'acqua, rifinisce le sponde e leviga gli argini (motore del
    §5.6).
- **Lago:** disegni un'area; viene scavata una conca naturale e riempita fino
  a un livello.
- Entrambi rispettano la protezione delle costruzioni.

### 5.10 Spawn e `level.dat`
- **Spawn del mondo:** clicca sulla mappa (Y = superficie, modificabile),
  angolo; `spawnRadius` da gamerule.
- **Bordo del mondo:** centro e dimensione, disegnati sulla mappa.
- **Regole di gioco:** tabella con tutte le gamerule presenti, ognuna con il
  controllo giusto (sì/no oppure numero).
- **Ora e meteo:** `DayTime`, pioggia e temporale con le relative durate.
- Ogni modifica a `level.dat` passa dal giornale, ed è riscritto gzip
  preservando tutte le altre chiavi.

### 5.11 Giocatori
- Elenco da `playerdata/*.dat`. Il nome si ricava dal `usercache.json` del
  launcher se c'è, altrimenti si mostra l'UUID.
- Per ogni giocatore:
  - posizione e dimensione, mostrate sulla mappa;
  - spawn personale/letto (`SpawnX/Y/Z`, `SpawnDimension` o il formato più
    recente);
  - inventario e ender chest in sola lettura, con le icone/nomi degli
    oggetti; in una fase successiva, modifica base (togli, cambia quantità).
- **Sposta il giocatore:** clicca un punto della mappa, anche in un'altra
  dimensione.
- Gestisci anche il giocatore single-player in `level.dat` → `Data.Player`.

### 5.12 Cerca blocchi
- Cerca per blocco, tag, block entity (spawner, baule con un certo oggetto
  dentro, cartello con un testo) o entità, nella selezione o in tutta la
  dimensione.
- Per saltare le sezioni senza corrispondenze usa le palette (come già fa
  `normalizeChunk`).
- I risultati vanno in un elenco (ordinabile e raggruppabile per chunk) e in
  marcatori sulla mappa; cliccandone uno si va lì. I risultati si possono
  esportare in CSV.

### 5.13 Potatura dei chunk
- Si eliminano chunk scegliendoli:
  - per selezione;
  - per `InhabitedTime` sotto una soglia (mostrato come heatmap sulla mappa);
  - perché sono fuori dal bordo del mondo;
  - oppure "tutti tranne quelli protetti"; la protezione si può dipingere a
    mano o essere automatica, sui chunk con blocchi artificiali.
- Rimuovi anche le voci `entities/` e `poi/` corrispondenti. Il gioco
  rigenererà quei chunk.
- Mostra quanto spazio si libera.

## 6. Applica
- Dialogo di conferma con:
  - nome della copia e percorso;
  - riassunto del giornale per tipo di operazione;
  - stima dei chunk e dei file da scrivere;
  - controlli preliminari: `session.lock`, spazio disco, compatibilità delle
    versioni.
- Procedura:
  1. Copia del mondo: clonazione APFS (`fs.cp` / `COPYFILE_FICLONE`) dove
     possibile, così è istantanea e non occupa spazio.
  2. Scrittura delle region toccate, in worker, con avanzamento per file.
  3. Verifica: rilettura dei chunk scritti.
  4. Report finale.
- Se qualcosa fallisce, la copia viene marcata come incompleta e l'originale
  resta intatto per costruzione.
- Dopo Applica: apri la copia in una nuova scheda (default), oppure continua
  a lavorare sull'originale.

## 7. Fasi
Fai push alla fine di ogni fase e aggiorna `editor/PROGRESS.md`:
cosa funziona, cosa manca, come provarlo, e i punti da verificare in gioco.
Non fermarti tra una fase e l'altra se non sei bloccato. Se lo sei, scrivi
la domanda in `PROGRESS.md` e segnalala nel messaggio finale.

0. **Scheletro:** Electron e script npm; schede dei mondi; mappa 2D che
   riusa `tiler.js` (sola lettura); slider della quota di taglio; barra di
   stato.
1. **Fondamenta di scrittura:**
   - NBT writer condiviso, region writer e serializzatore dei chunk;
   - giornale e overlay, Annulla/Ripeti;
   - Applica su una copia;
   - test di round-trip e test "l'originale non cambia".

   Prima funzione vera: **Spawn + level.dat** (§5.10), la più semplice per
   provare tutta la catena.
2. Selezioni (§5.1), **biomi** (§5.2), **sostituzione** (§5.7), **cerca**
   (§5.12).
3. **Copia, taglia e incolla** con rotazione, specchio, entità e
   multi-mondo (§5.3).
4. **Appunti salvati e schematiche** (§5.4).
5. **Motore del terreno:** pennelli (§5.6), poi **fusione dei bordi** (§5.5)
   e protezione delle costruzioni.
6. **Vegetazione** (§5.8), **fiumi e laghi** (§5.9).
7. **Giocatori** (§5.11), **potatura** (§5.13).
8. Applicazione definitiva del design di `editor/design/`, rifinitura e
   `.app` pacchettizzata.

## 8. Test e verifica
- Test unitari in Node per tutto `editor/core/`, eseguiti da `npm test`.
- Test di round-trip:
  - NBT;
  - region (comprese le posizioni dei settori dopo modifiche che allargano
    o restringono i chunk);
  - chunk;
  - schematiche.
- Usa e estendi `test/make-test-world.js` per avere fixture con block
  entity, entità, biomi vari, Nether ed End.
- Proprietà da verificare:
  - 4 rotazioni = identità;
  - specchio² = identità;
  - copia → incolla nello stesso punto = mondo invariato;
  - la fusione non tocca mai una colonna protetta;
  - la sostituzione conserva le proprietà.
- Minecraft non si può avviare qui, quindi ogni fase deve lasciare in
  `PROGRESS.md` una **checklist "prova in gioco"** precisa (che mondo aprire,
  cosa fare, cosa si deve vedere). L'utente la eseguirà sul Mac.

## 9. Convenzioni
- UI e messaggi di commit in **italiano**. Commenti nel codice in
  **inglese**, con lo stile e la densità di `web/js/core/`.
- Dipendenze: `electron` ed `electron-builder`. Ogni altra dipendenza va
  giustificata in `PROGRESS.md`; preferisci codice proprio, piccolo e
  testato.
- Aggiorna il `README.md` con una sezione "Cantiere": cos'è, come si avvia,
  come si crea la `.app`, e il fatto che scrive sempre su una copia.
