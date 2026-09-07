# Guida all'Atlante 3D

Il README racconta *cosa fa* Cube-Atlas e come si usa. Questo file racconta
com'è fatta dentro la **modalità Atlante 3D** — la ricostruzione tridimensionale
di una porzione del mondo — perché è fatta così, e dove sono i punti in cui è
facile romperla. Se devi metterci le mani, parti da qui.

L'Atlante 3D è nato come applicazione a sé (`3d_minecraft`, ora archiviata) ed
è stato integrato in Cube-Atlas il 7 settembre 2026. Questa guida viene da lì,
aggiornata ai nomi e ai percorsi di casa nuova.

Ultimo aggiornamento: 7 settembre 2026 (integrazione in Cube-Atlas).

---

## 1. In che stato è

Funzionante e verificato. Non è un prototipo: legge salvataggi veri, i test
passano, l'ho guardato girare nel browser su due mondi diversi.

Cosa c'è, di preciso:

- lettura di un salvataggio Java Edition 1.13+ — ma il mondo **non lo apre
  questa schermata**: usa quello che l'Editor ha già aperto (vedi §2.1);
- scelta di una porzione con anteprima dall'alto cliccabile, spostabile con le
  frecce ai lati;
- ricostruzione 3D della porzione, con le forme vere dei blocchi (lastre,
  scale, recinti, piante, acqua, vetro…);
- **texture originali del gioco**, lette dal `.jar` che l'utente indica, con
  ripiego sulle tinte piatte quando non ce n'è uno;
- navigazione a orbita, coordinate F3, nome del blocco sotto il mirino, taglio
  in altezza, salvataggio dell'immagine;
- esportazione della porzione come `.glb` (geometria, texture e colori cotti),
  con il taglio in altezza applicato sul piano;
- 57 test dedicati dentro `npm test`, che ne conta 129 in tutto.

Cosa **non** c'è, e non per dimenticanza — vedi §10 per il perché:

entità, luce del gioco, angoli delle scale, geometria presa dai modelli del
gioco, sezione vera del terreno quando si taglia in altezza.

---

## 2. Da dove viene, e cosa non va toccato

L'Atlante 3D è arrivato da fuori — era un'applicazione separata — e questo
spiega la forma che ha.

Come le altre due sezioni ha due modalità: l'**Editor**, che ha bisogno del
mondo aperto e costruisce la porzione, e la **Lettura**, che non ha bisogno di
niente e riapre un `.glb` già esportato (`app/glbReader.js`). Attenzione a un
dettaglio che si sbaglia facilmente: anche il lettore deve fare
`THREE.ColorManagement.enabled = false` e tenere l'`outputColorSpace` lineare,
come `viewer3d.js` e per lo stesso motivo (§7). Senza, i colori cotti nei
vertici vengono convertiti una seconda volta e lo stesso modello esce
visibilmente più chiaro di com'era nell'Editor che l'ha prodotto.

**`web/js/core/` è condiviso con la mappa 2D, ed è una copia sola.** Sono i
file — `nbt.js`, `anvil.js`, `worldScan.js`, `source.js`, `blockColors.js` —
che sanno leggere NBT, aprire i file di regione, trovare le dimensioni dentro
un salvataggio e dare un colore a ogni blocco. Li usano tutte e due le
modalità: quello che correggi lì lo correggi per entrambe, ed è il motivo per
cui vale la pena non duplicarli mai.

Se ti serve un comportamento diverso da quello che offrono, **estendi da
fuori** invece di modificarli: è esattamente ciò che fa `voxel/volume.js`, che
riusa `RegionFile`, `loadRegionFile`, `readSpanningPacked`, `readPaddedPacked`,
`blockBits` e `biomeBits` di `anvil.js` senza cambiarne una riga, e ci
ricostruisce sopra il pezzo che gli mancava (le *proprietà* degli stati, vedi
§5.2).

Quello che appartiene solo all'Atlante 3D:

```
web/js/voxel/     blockKinds.js  volume.js  mesher.js
web/js/pack/      zip.js  resources.js  textures.js
web/js/export/    glb.js
web/js/worker3d.js
web/js/app/       atlas3d.js  viewer3d.js  engine3d.js  packPicker.js
web/css/atlas3d.css
test/make-showcase-world.js  test/make-zip.js
```

### 2.1 Il mondo arriva dall'Editor, il worker no

Due cose che sembrano una sola e non lo sono:

- **il salvataggio** è lo stesso che l'Editor ha già aperto. `atlas3d.js` non
  ha un selettore di cartella: riceve da `main.js` come raggiungere il mondo
  (`getWorldInit`) e quale dimensione è selezionata, e li riapre sul worker
  suo. Entrare nella schermata due volte sullo stesso mondo non costa niente:
  `syncWorld()` riscansiona solo se cartella o dimensione sono cambiate.
- **il worker è un altro.** `web/js/worker.js` dipinge tessere dall'alto,
  `web/js/worker3d.js` legge volumi e costruisce triangoli. Non è pigrizia:
  sono due mestieri con cache, strutture dati e tempi diversi, e tenerli
  separati significa che generare la mappa e caricare una porzione 3D non si
  bloccano a vicenda.

Il ponte fra i due sta in `main.js`, dove `Atlas3D.init({...})` passa i due
getter, e in `showScreen()`, che chiama `Atlas3D.show()` quando la schermata
diventa visibile — serve perché la tela 3D si misura da sola e mentre è
nascosta è larga zero.

L'unica dipendenza esterna è **three.js r169** (MIT), messa a mano in
`web/vendor/three.module.js`. Niente `npm install`, niente build: `npm test` e
`npm run web` funzionano su una copia appena scaricata. Se aggiorni three.js,
scarica il file `build/three.module.js` della versione che vuoi e sostituiscilo
— non c'è nient'altro da fare.

---

## 3. Metterlo in moto in due minuti

```bash
npm run web        # http://127.0.0.1:5173
npm test           # 129 test, 57 dei quali sull'Atlante 3D
npm run showcase   # rigenera il mondo vetrina delle forme
npm run world      # rigenera il mondo sintetico di terreno
```

`npm run web` serve solo file statici. Da `file://` **non** funziona: il
browser blocca i Web Worker.

### Il trucco che ti servirà: `?dev`

Nessuno script può pilotare il selettore di cartella del browser, quindi
provare una modifica cliccando ogni volta «Scegli la cartella…» è una tortura,
e automatizzarlo è impossibile. Per questo `tools/serve.js` sa esporre una
cartella di mondo via HTTP:

```bash
WORLD=~/Library/Application\ Support/minecraft/saves/IlMioMondo \
PACK=~/Library/Application\ Support/minecraft/versions/1.21.10/1.21.10.jar \
npm run web
```

e poi <http://127.0.0.1:5173/?dev>: l'app apre quel mondo da sola, saltando il
selettore. Senza `WORLD` usa `data/testworld`; senza `PACK` l'Atlante 3D parte
a tinte piatte.

Dietro le quinte sono quattro pezzi: tre rotte nel server (`/__world/<file>`,
`/__world_ls?path=` e `/__pack`), una `HttpSource` in `core/source.js` (una
ventina di righe che implementano `WorldSource` con `fetch`) e poche righe in
`main.js` che leggono il parametro. **Nel flusso normale dell'app non esiste**:
nessun bottone lo raggiunge, e `sourceFromInit` costruisce una `HttpSource`
solo se qualcuno gli passa `{kind:'http'}`, cosa che fa soltanto il ramo
`?dev`.

### I due mondi di prova

- **`npm run world`** → `data/testworld`, 512×512 blocchi di terreno: colline,
  fiume, lago, spiaggia, picco innevato. È il mondo su cui gira tutta la suite,
  mappa 2D compresa; serve a provare la *lettura* e le prestazioni su volumi
  grandi.
- **`npm run showcase`** → `data/showcase`, 64×64 blocchi di sole forme
  particolari: casa con porta, finestre di vetro e tetto di scale, recinto con
  cancello, sentiero di lastre, muretto, laghetto con ninfee, prato fiorito,
  albero, scalinata, scatola di vetro, neve a strati, binari, lava.
  **L'ho scritto apposta** perché il primo è tutto terreno e non contiene né
  una scala né un fiore: con quello soltanto non puoi accorgerti che le lastre
  sono alte un blocco intero o che i recinti non si attaccano.

Se aggiungi il supporto per una forma nuova, aggiungila anche lì.

---

## 4. Il percorso di un blocco, dal file al pixel

Vale la pena leggere questa sezione prima di toccare qualsiasi cosa: sono sei
passaggi e ognuno ha un file suo.

```
  cartella del mondo
        │  worldPicker.js  →  {kind:'handle'|'files'}
        ▼
  ┌─ WEB WORKER ─────────────────────────────────────────────┐
  │  core/source.js      leggere i byte di un file           │
  │  core/worldScan.js   quali dimensioni ci sono            │
  │  core/anvil.js       aprire r.X.Z.mca, scompattare       │
  │  voxel/volume.js     una scatola di mondo → Uint16Array  │
  │  voxel/blockKinds.js stato del blocco → forma            │
  │  pack/zip.js         aprire il .jar senza scompattarlo   │
  │  pack/resources.js   stato del blocco → texture          │
  │  pack/textures.js    texture → array di strati           │
  │  voxel/mesher.js     forme + strati → triangoli          │
  └──────────────────────────────────────────────────────────┘
        │  postMessage, una colonna alla volta, trasferita
        ▼
  app/engine3d.js →   app/viewer3d.js →   three.js   →   schermo
```

**1. Scegliere il mondo.** Lo fa l'Editor, non questa schermata (§2.1).
`app/worldPicker.js` restituisce un *descrittore*:
`{kind:'handle', handle}` con la File System Access API (Chrome/Edge, e lo si
può ricordare in IndexedDB) oppure `{kind:'files', files: Map}` con
`<input webkitdirectory>` (Safari/Firefox). Entrambi attraversano
`postMessage` senza problemi, quindi il worker li riceve tali e quali e
`makeSource()` li trasforma nella `WorldSource` giusta.

**2. Scansione.** `scanWorld(source)` cerca *qualunque* cartella contenga file
`r.X.Z.mca` e ne deduce la dimensione, invece di dare per scontati i nomi
`region/`, `DIM-1/`, `DIM1/`. Funzionano anche i layout
`dimensions/minecraft/overworld/region/`. Restituisce anche nome del mondo,
versione e punto di spawn.

**3. Anteprima.** L'handler `survey` chiama `readSurface()` di `anvil.js` — la
stessa funzione che disegna le mattonelle dell'atlante 2D — colora ogni colonna
con `colorFor(blocco, bioma)`, aggiunge un filo di ombreggiatura di pendenza e
rimanda indietro un `Uint8ClampedArray` RGBA. Restituisce anche `ground:{lo,hi}`
calcolato **solo sul rettangolo selezionato** (`focus`), ed è da lì che esce
l'altezza automatica.

**4. Leggere il volume.**
`readVolume(source, regionDir, {minX,minY,minZ,sizeX,sizeY,sizeZ}, options)`
→ vedi §5.

**5. Risolvere le texture** (solo se è stato scelto un pacchetto).
`buildTextureLayers(pack, vol, …)` guarda la palette *di questa porzione* e
costruisce un array di texture con dentro solo le sagome che servono, più la
tabella «stato + faccia → strato». Vedi §7.

**6. Costruire la geometria.** `buildTables(vol, textures)` prepara le tabelle
per stato (forma, tipo, colore, trasparenza, strati), poi
`meshColumn(vol, tables, colX, colZ)` viene chiamata per ogni colonna di 16×16
blocchi. Ognuna restituisce `{opaque, plants, translucent, quads}`, dove ogni
pezzo è `{positions, colors, indices, uvs?, layers?}`.

**6. Disegnare.** `viewer.addColumn(data)` costruisce una `BufferGeometry` per
pezzo e la aggiunge alla scena. Tre materiali: opaco, piante (con `alphaTest`,
quindi ancora nella passata opaca), trasparente.

### I messaggi fra pagina e worker

`app/engine3d.js` è il client: promesse + due canali laterali.

| richiesta | payload | risposta |
|---|---|---|
| `openWorld` | `{init}` | il risultato di `scanWorld` |
| `openPack` | `{files}` | `{ok, packs, names}` — apre i .jar/.zip delle texture |
| `closePack` | — | dimentica le texture |
| `player` | — | `{x,y,z}` o `null` (da `level.dat`, `Data.Player.Pos`) |
| `survey` | `{dimId, minX, minZ, width, depth, hiddenBlocks, focus}` | `{rgba, ground, …}` |
| `load` | `{dimId, box, hiddenBlocks, textured}` | `{box, quads, stats, textured, textureLayers, blocks, states, names, props}` |

Durante `load` arrivano anche:

- `{type:'progress', progress:{phase:'read'|'textures'|'mesh', value}}`
- `{type:'stream', data:{kind:'textures', tile, layers, data}}` — **prima** dei
  chunk, perché decide quali materiali useranno
- `{type:'stream', data:{kind:'column', x, z, opaque, plants, translucent}}`

Le mesh sono **trasferite**, non copiate (`postMessage(msg, transfer)`): dopo
il trasferimento il worker non le possiede più, ed è quello che vuoi. Alla fine
anche `vol.blocks` viene trasferito alla pagina, che ne ha bisogno per dire che
blocco c'è sotto il mirino senza richiederlo al worker sessanta volte al
secondo.

---

## 5. `volume.js` — leggere una scatola di mondo

### 5.1 La forma del risultato

```js
{
  minX, minY, minZ, sizeX, sizeY, sizeZ,
  blocks:  Uint16Array,   // [(y * sizeZ + z) * sizeX + x] → indice di stato
  biomes:  Uint8Array,    // una cella ogni 4×4×4 blocchi
  states:  [...],         // chiavi: "minecraft:oak_slab|type=top"
  names:   [...],         // "minecraft:oak_slab"
  props:   [...],         // {type:'top'} oppure null
  biomeNames: [...],
  stats: { chunks, missing, unparsed },
}
```

Lo **stato 0 è sempre l'aria**: un volume appena allocato è già vuoto, e i
chunk mai generati non costano niente. `x`, `y`, `z` sono *locali* alla
scatola; per le coordinate del gioco somma `minX`/`minY`/`minZ`.

`minX`, `minZ`, `minY` e le dimensioni devono essere **multipli di 16** — è
quello che allinea sezioni e celle di bioma. `atlas3d.js` ci pensa da solo
(`snapDown16` / `snapUp16`), ma se chiami `readVolume` da altrove ricordatene.

I biomi stanno alla risoluzione con cui il gioco li salva davvero, una cella
ogni 4×4×4 blocchi: sessantaquattro volte meno memoria di una per blocco, e
non si perde niente perché più di così il salvataggio non sa.

### 5.2 Perché non basta `analyzeChunk` di `anvil.js`

L'atlante 2D, di ogni colonna, vuole solo il blocco più in alto: `anvil.js` gli
dà quello, e nel farlo butta via le `Properties` della palette tenendo il solo
`Name`. In 3D quelle proprietà **sono geometria**: fra `type=top` e
`type=bottom` di una lastra ci sono mezzo blocco di differenza, e una porta
senza `facing` non sai da che parte metterla.

Quindi `volume.js` rilegge la palette per conto suo e costruisce una chiave di
stato che tiene il nome **più le sole proprietà che cambiano la forma**
(`SHAPE_PROPS` in `blockKinds.js`: `type`, `half`, `facing`, `open`, `hinge`,
`layers`, `shape`, `axis`). Tutto il resto — `waterlogged`, `power`,
`distance`, `persistent`… — è scartato di proposito: moltiplicherebbe la
palette senza spostare un vertice.

C'è un test che lo fissa: due lastre `type=top` che differiscono solo per
`waterlogged` devono avere la stessa chiave.

### 5.3 Il filtro dei blocchi

`options.hiddenBlocks` è un `Set` di nomi letti come aria. È applicato **in
lettura**, rimappando quelle voci della palette sullo stato 0: costa zero e fa
sparire il blocco anche dal calcolo delle facce nascoste, che è il punto —
altrimenti una serra di vetro resterebbe una scatola opaca vista da fuori.
Cambiare il filtro richiede però di rileggere tutto.

---

## 6. `mesher.js` — il pezzo delicato

Tre idee, in quest'ordine.

**Face culling.** Si disegnano solo le facce fra un blocco pieno e qualcosa
attraverso cui si vede. Una colonna 16×16×256 ha 65 536 blocchi e 393 216
facce; dopo lo scarto ne restano qualche migliaio.

**Greedy meshing.** Le facce complanari che verrebbero disegnate identiche si
fondono in un rettangolo solo: un prato piatto costa un quadrilatero invece di
uno per blocco. Ci passano **solo i cubi pieni** e il vetro; le forme strane
sono poche e vengono emesse una alla volta.

**Luce cotta.** Nella scena **non ci sono luci**. L'ombreggiatura della faccia
(`SHADE = [0.62, 1, 0.8]` per asse, `0.5` sotto — gli stessi rapporti del
gioco) e l'occlusione ambientale agli angoli (`AO_LIGHT = [0.44, 0.64, 0.82,
1]`) sono già moltiplicate dentro il colore dei vertici. Il materiale è
`MeshBasicMaterial`: la GPU non calcola niente, e 124 000 triangoli si
disegnano in cinque millisecondi.

### Le sette trappole

Sono i punti in cui ho già sbagliato, o in cui è ovvio sbagliare. Ognuno ha il
suo test.

**1. Il bit-packing cambia con la versione.** Fino al `DataVersion` 2528
(1.15.x) gli indici della palette sono impacchettati fitti e un valore **può**
essere spezzato fra due `long`; dal 2529 (1.16) ogni `long` è riempito solo per
`floor(64/bit)` valori e nessun valore attraversa il confine. `volume.js`
sceglie `readPaddedPacked` o `readSpanningPacked` in base al `DataVersion` del
chunk. Sbagliando, il mondo esce plausibile ma con i blocchi sbagliati — non se
ne accorge nessuno finché non guarda bene. Il test `ogni blocco letto è quello
che il mondo di prova ci ha scritto` confronta **tutte** e 20 480 le celle di
una scatola con quello che il generatore ci aveva messo.

**2. La proprietà dei bordi, nel greedy.** Il mesher passa una lastra alla
volta lungo ogni asse e, per ogni cella della lastra, guarda il blocco *prima*
e quello *dopo*. I vicini vanno letti dal **volume intero**, non solo dalla
colonna: se leggessi aria fuori dalla colonna, ogni chunk uscirebbe avvolto in
un guscio visibile. Ma la faccia va emessa **solo se il blocco che la possiede
sta in questa colonna** (`s >= 0` per le facce `+d`, `s + 1 < dims[d]` per
quelle `−d`), altrimenti due colonne vicine emettono la stessa faccia due
volte, e in trasparenza si vede.

**3. I piani delle facce non sono interi.** La faccia superiore di una lastra
sta a `y + 0.5`, il pelo dell'acqua a `y + 0.875`. Lo `scratch` in cui il
mesher costruisce i vertici era un `Int32Array`, e troncava silenziosamente:
lastre e acqua uscivano alte un blocco intero, senza nessun errore. Ora è un
`Float64Array` e c'è un commento che dice perché. Se tocchi quella zona,
ricordatene.

**4. L'orientamento e la diagonale.** I quadrilateri sono emessi negli angoli
`(u0,v0) (u1,v0) (u1,v1) (u0,v1)`, che è antiorario visto da `+d` perché
`(d+1, d+2, d)` è sempre una rotazione ciclica di `(0,1,2)`. Per una faccia
rivolta dall'altra parte i vertici escono al contrario — **e questo scambia
anche quale diagonale taglia il quadrilatero**, per cui il flag `flip` va
invertito. Se sbagli, l'occlusione ambientale si piega dalla parte sbagliata su
metà delle facce: si vede solo negli angoli, di sbieco.

**5. Si fondono solo le facce illuminate uniformemente.** Stirare un gradiente
di occlusione ambientale su un rettangolo lungo non ripete l'ombra, la spalma.
Perciò `same()` pretende che i quattro angoli abbiano lo stesso valore
(`mUni`); se non ce l'hanno, la faccia resta 1×1. È il motivo per cui il conto
dei quadrilateri sale vicino agli spigoli, ed è voluto.

**6. Lo spazio colore.** I valori di `blockColors.js` sono già il colore che
deve finire sullo schermo, gli stessi che l'atlante 2D dipinge su una canvas.
Se li lasci passare per la gestione del colore di three.js vengono interpretati
come lineari e riconvertiti: lo stesso mondo esce **più chiaro** in 3D che
sulla mappa. Per questo `viewer3d.js` fa `THREE.ColorManagement.enabled = false`
e `renderer.outputColorSpace = THREE.LinearSRGBColorSpace`. Non toglierli senza
riconvertire i colori a monte.

**7. Le piante hanno bisogno della maschera.** Due quadrilateri incrociati di
colore pieno, alti un blocco, non sembrano erba: sembrano bandiere. Un prato
diventa un campo di stendardi colorati. La maschera di ritaglio (`plantTexture()`
in `viewer3d.js`, disegnata a mano su una canvas 32×16: fili d'erba a sinistra,
un fiore sul suo stelo a destra) più l'altezza giusta per specie
(`PLANT_HEIGHT`) sono ciò che rende la differenza fra «prato» e «bandiere».
`alphaTest: 0.5` le tiene nella passata opaca, così non c'è niente da ordinare.

### Le tre passate

| passata | cosa contiene | materiale |
|---|---|---|
| `opaque` | cubi pieni (greedy) + scatole + pali opachi | `MeshBasicMaterial` |
| `plants` | croci con uv | `alphaTest: 0.5`, `DoubleSide` |
| `translucent` | acqua, vetro, vetrate | `transparent`, `depthWrite:false`, `DoubleSide` |

Il materiale delle piante è a doppia faccia, quindi **un quadrilatero per
piano basta**: non emetterne due.

---

## 7. Le texture del gioco

Le sagome non sono nostre da ridistribuire: stanno nel `.jar` che l'utente ha
già installato. L'app se le fa indicare una volta, le legge in locale come
legge il mondo, e se la scelta manca torna alle tinte piatte — le due strade
convivono, e nessuna delle due è un ripiego mal fatto.

### La catena

**`pack/zip.js`** — un `.jar` è uno zip, e uno zip si legge dal fondo: la
tabella di cosa c'è dentro sta in coda al file. Quindi invece di caricare
quaranta megabyte per prendere quattrocento PNG da mezzo kilobyte, si leggono
gli ultimi kilobyte, si cerca la voce e si scaricano solo quei byte. La
decompressione è `DecompressionStream('deflate-raw')` del browser — lo stesso
motivo per cui `core/nbt.js` non ha bisogno di una libreria di inflate, e il
motivo per cui questo file non ha dipendenze.

**`pack/resources.js`** — da stato del blocco alle sei texture delle sue facce,
leggendo i file del gioco invece di una tabella scritta a mano:

- `assets/minecraft/blockstates/<nome>.json` dice quale modello usa ogni stato.
  Le varianti vengono confrontate con le proprietà del blocco e si sceglie
  quella che combacia di più — è così che `axis=x` prende il tronco sdraiato.
- `assets/minecraft/models/block/<modello>.json` dice quali texture vanno su
  quali facce, attraverso una catena di `parent` e di variabili `#riferimento`.
  I genitori si fondono (vince il figlio) e i `#` si risolvono sulla mappa
  fusa: è così che l'unico `"#all"` di `cube_all` diventa sei sagome vere.

**`pack/textures.js`** — decodifica i PNG che servono e li impila in un array
di texture. Vengono caricate **solo le sagome dei blocchi presenti nella
porzione**: un prato ne usa una decina, non le milleduecento che il gioco
contiene.

**`viewer3d.js`** — uno `ShaderMaterial` scritto a mano che campiona l'array e
moltiplica per il colore dei vertici, che continua a portare ombreggiatura,
occlusione ambientale e tinta di bioma.

### Perché un array di texture e non un atlante

È la scelta su cui regge tutto il resto. Con un atlante, le sagome stanno tutte
in una immagine sola, e una faccia fusa larga quattro blocchi non può far
ripetere la sua mattonella: le coordinate uscirebbero dal riquadro e
prenderebbero il pixel della sagoma vicina. Le due vie d'uscita sarebbero
rinunciare alla fusione (e moltiplicare i triangoli per dieci) o fare `fract()`
nello shader con i bordi di ogni mattonella passati come attributo.

Un *array di texture* di WebGL2 tiene ogni sagoma in uno strato suo, e ogni
strato si ripete per conto proprio. Così una faccia fusa 4×4 fa scorrere le sue
coordinate da 0 a 4 e la texture si ripete quattro volte, senza che entri
niente da fuori. **Il conto delle facce con le texture è identico a quello
senza**: 62 000 in entrambi i casi sulla porzione di prova da 256 blocchi.

### Le coordinate vengono dalla posizione nel mondo

Non da un rettangolo calcolato per faccia. Per ogni direzione c'è una mappa
(`faceUV` in `mesher.js`): sulle facce laterali il verticale della texture è la
Y del mondo, in cima è `x` e `-z`, e così via. Due conseguenze, entrambe
gratuite:

- le coordinate restano continue lungo un rettangolo fuso, che è ciò che fa
  funzionare il punto precedente;
- **le forme parziali si ritagliano da sole**: il fianco di una lastra va da
  `y` a `y+0.5`, quindi mostra la metà bassa della sua texture, esattamente
  come la disegna il gioco. Nessun caso speciale per lastre, scale, tappeti,
  neve o botole.

### Le quattro trappole

**1. In GLSL 3 non esiste `gl_FragColor`.** L'array di texture obbliga a
`glslVersion: THREE.GLSL3` (`sampler2DArray` non esiste prima), e lì l'uscita
del fragment shader va dichiarata. three.js lo fa per i suoi materiali ma non
per i nostri, e il suo pezzo di codice per la nebbia scrive su `gl_FragColor`:
quindi il nome va fatto esistere a mano, con
`layout(location = 0) out highp vec4 pc_fragColor;` e un `#define`. Senza,
niente si disegna e l'errore compare solo nella console.

**2. Le foglie sono texture bucate, ma la chioma è un guscio.** Le facce fra
due blocchi di foglie non vengono disegnate (si occludono a vicenda), quindi
lasciando i buchi si vedrebbe il cielo *attraverso* l'albero. Le sagome dei
cubi pieni si riempiono (`fillHoles`), come fa la grafica "veloce" del gioco.
L'alternativa — non far occludere le foglie fra loro — raddoppierebbe i
triangoli di un bosco.

**3. Il colore trasparente non sopravvive alla canvas.** Una canvas conserva
l'alfa premoltiplicata, quindi dopo `drawImage` + `getImageData` i pixel
trasparenti tornano neri: il loro colore originale non c'è più. Per questo
`fillHoles` ricostruisce la tinta dalla media dei pixel opachi invece di
tenersi quella che c'era.

**4. Una texture nei modelli non è sempre una stringa.** Dalle versioni del
2026 può essere un oggetto, `{sprite, force_translucent}`. Ogni valore passa
per `spriteOf()` prima che qualcuno lo guardi: senza, vetro e vetrate
sparivano — e sparivano in silenzio, tornando semplicemente «nessuna texture».

### E la tinta di bioma?

Le sagome di erba e fogliame del gioco sono grigie: è la tinta a colorarle.
Quindi in modalità texture il colore dei vertici non è più il colore del blocco
ma **la tinta da sola** (bianco dove il gioco non tinge), e `colorFor()` di
`blockColors.js` — che la tinta la moltiplica dentro il colore del blocco — va
diviso all'indietro. Lo fa `tintOf()` in `mesher.js`.

### Portare fuori le texture: l'export `.glb`

`web/js/export/glb.js` deve consegnare a glTF una scena che glTF, così com'è,
non sa rappresentare. Due ostacoli, e vale la pena capirli perché è lo stesso
motivo per cui l'array di texture esiste:

1. **glTF non ha array di texture.** Ha immagini e campionatori, e basta.
2. **Le coordinate si ripetono.** Un rettangolo unito dal greedy meshing largo
   quattro blocchi fa correre le sue coordinate da 0 a 4 e lascia ripetere il
   campionatore. È tutto il punto degli strati.

La soluzione ovvia — cuocere gli strati in un unico atlante — rompe il punto 2:
coordinate che si ripetono su un atlante trascinano dentro lo sprite del
vicino. L'alternativa è **spezzare la geometria per farla stare in un atlante**,
un quad per tile, e allora tanto vale non aver mai fatto il greedy meshing.

Quindi: **ogni strato diventa una sua immagine e un suo materiale**, con il
campionatore su `REPEAT`. Le coordinate significano esattamente quello che
significavano sullo schermo, i vertici non aumentano di uno, e i triangoli
vengono solo *riordinati* per (famiglia, strato). Sul mondo di prova 174 mesh
diventano 2 primitive; con le texture diventano una manciata, una per sprite.

Due dettagli che sembrano piccoli e non lo sono:

- **I materiali sono `KHR_materials_unlit`.** L'ombreggiatura delle facce,
  l'occlusione ambientale e la tinta di bioma sono già moltiplicate nei colori
  dei vertici. Un visualizzatore che li illuminasse di nuovo li illuminerebbe
  due volte, e il risultato sarebbe più scuro e sbagliato.
- **Il taglio in altezza taglia sul serio.** Non basta buttare i triangoli
  sopra il piano: il mesher unisce una parete piatta in *un solo rettangolo
  alto*, quindi tenerlo o buttarlo intero sbaglia di decine di blocchi.
  `clipTriangle()` è un Sutherland–Hodgman contro un piano solo, e interpola
  anche colore e coordinate.

I colori escono come `COLOR_0` in RGBA anche se l'alfa non la legge nessuno:
glTF vuole ogni elemento di vertice allineato a quattro byte, e un `VEC3` di
byte ne occuperebbe tre.

## 8. Aggiungere una forma nuova: la ricetta

Diciamo che vuoi che i **calderoni** smettano di essere cubi pieni.

1. **Guarda il modello vero.** In Minecraft le scatole si misurano in
   sedicesimi: `blockKinds.js` esporta `S = 1/16` proprio per scriverle come le
   scrive il gioco. Un calderone è un guscio: approssimalo con una scatola
   `[0, 0, 0, 1, 1, 1]` cava o, più semplicemente, con quattro pareti.

2. **Classificalo** in `classifyName()`, prima del `return CUBE_SHAPE` finale.
   L'ordine dei controlli conta: i casi speciali vanno **prima** dei suffissi
   generici (`_slab`, `_stairs`), e i suffissi generici prima del fondo.

   ```js
   if (name === 'cauldron' || name.endsWith('_cauldron')) {
     return box([
       [0, 0, 0, 1, 3 * S, 1],                    // il fondo
       [0, 3 * S, 0, 2 * S, 1, 1],                // parete ovest
       [1 - 2 * S, 3 * S, 0, 1, 1, 1],            // parete est
       [2 * S, 3 * S, 0, 1 - 2 * S, 1, 2 * S],    // parete nord
       [2 * S, 3 * S, 1 - 2 * S, 1 - 2 * S, 1, 1] // parete sud
     ]);
   }
   ```

3. **Se ti servono proprietà** che ora vengono scartate (per esempio il livello
   dell'acqua dentro), aggiungile a `SHAPE_PROPS`. Attenzione: ogni proprietà
   in più moltiplica le voci della palette, quindi mettici solo quelle che
   cambiano davvero la geometria.

4. **Mettilo nel mondo vetrina** (`test/make-showcase-world.js`), così lo vedi.

5. **Scrivi il test.** Guarda quelli in `Forme dei blocchi`: sono tre righe
   l'uno e fissano le misure, non l'aspetto.

6. **Guardalo davvero**, con `npm run showcase && npm run web` e `?dev`. I test
   dicono che le scatole sono dove volevi; non dicono che sembra un calderone.

Le forme disponibili sono `air`, `skip`, `cube`, `glass`, `water`, `plant`,
`box` (una o più scatole), `post` (palo con braccia verso i vicini). Se ti
serve qualcosa che non rientra in nessuna, il posto dove aggiungerla è la
seconda passata di `meshColumn`, insieme a `emitWater`, `emitCross` ed
`emitPost`.

### Aggiungere o correggere un colore

I colori stanno in `core/blockColors.js`, che è **condiviso con Cube-Atlas**:
una correzione qui vale anche per la mappa 2D, quindi mandala anche di là. I
blocchi non elencati ricevono un colore stabile derivato dal nome — brutto ma
distinguibile, mai invisibile. Le tinte per bioma (erba, fogliame, acqua) si
applicano dalla 1.18 in poi, prima i biomi erano id numerici e non li leggiamo.

---

## 9. Provare le modifiche

**I test** (`npm test`, ~2 secondi) coprono le forme, il mesher e la lettura.
Non hanno bisogno né di browser né di dipendenze: il mesher lavora su volumi
costruiti a mano con `makeVolume()`, e la lettura su un file di regione vero
generato da `make-test-world.js`.

Le funzioni di appoggio in `run-tests.js` valgono più di quanto sembri:
`quadsFacing(mesh, nx, ny, nz)` ti dà tutti i quadrilateri rivolti in una certa
direzione (la normale la calcola dall'avvolgimento del primo triangolo), e
`vertex(mesh, q, k)` il vertice `k` del quadrilatero `q`. Con quelle due puoi
scrivere asserzioni sulla geometria in una riga.

**A vista**, che per un renderer è metà del lavoro:

```bash
npm run showcase
PACK=~/Library/Application\ Support/minecraft/versions/1.21.10/1.21.10.jar npm run web
# poi ?dev
```

Guarda **sempre entrambe le modalità**: la casella *"Usa le texture"* le
scambia senza ricaricare la pagina, e una modifica al mesher può funzionare in
una e rompersi nell'altra.

Se vuoi misurare invece di guardare, dalla console del browser:

```js
// tempo per fotogramma, disegni, triangoli
const t0 = performance.now();
for (let i = 0; i < 30; i++) renderer.render(scene, camera);
(performance.now() - t0) / 30;
renderer.info.render.calls;
renderer.info.render.triangles;
```

`viewer` non è esposto su `window` di proposito. Se ti serve per una sessione
di debug, aggiungi `window.__viewer = viewer` in `ensureViewer()` e **togliilo
prima di committare** — l'ho fatto anch'io mentre lo costruivo.

**Numeri di riferimento**, misurati su una porzione di 256×256 blocchi alta 96
(6,3 milioni di blocchi) del mondo di terreno:

| | |
|---|---|
| chunk letti | 256 |
| quadrilateri dopo il culling e la fusione | 62 000 |
| triangoli | 124 000 |
| mesh (e quindi disegni) | 297 |
| tempo per fotogramma | 5,6 ms (6,0 con le texture) |
| sagome caricate | 11, per quel mondo |

Se una modifica fa salire di molto il conto dei quadrilateri, quasi sempre hai
rotto la fusione: il sospettato numero uno è aver messo qualcosa che varia per
blocco (rumore, coordinate, tempo) dentro la chiave di fusione. È esattamente
quello che fa apposta `isVaried` per le foglie, e infatti le foglie costano più
delle altre superfici.

---

## 10. Le scelte che ho preso, e perché

Le scrivo perché la prima reazione, guardando il risultato, è «manca X»: in
quasi tutti i casi X è stato valutato e scartato.

**Dai modelli del gioco prendiamo le texture, non la geometria.** I file
`models/block/*.json` contengono anche gli `elements`, cioè le scatole vere di
ogni blocco: leggendoli si otterrebbe la forma esatta di tutto, angoli delle
scale compresi, e `blockKinds.js` sparirebbe. È il lavoro grosso che resta da
fare, ed è grosso davvero: rotazioni dei modelli, uv esplicite per faccia,
multipart per recinti e muretti, `tintindex` per capire cosa tingere. Le sagome
scritte a mano coprono quello che si vede, e il resto è §11.

**Le tinte piatte restano.** Non sono un ripiego mal fatto: senza un `.jar`
indicato l'app funziona uguale, e il percorso a tinte piatte ha i suoi test.
Serve a chi apre il mondo su un computer dove Minecraft non è installato — e a
guardare la forma delle cose senza il rumore delle texture.

**Niente entità.** Né mob, né quadri, né contenuto dei bauli. Si leggono da
`entities/` e dai block entity dei chunk: è un lettore in più, non tocca
niente di quello che c'è, e si può aggiungere quando serve.

**Il taglio in altezza apre il terreno invece di sezionarlo.** È un piano di
taglio della GPU, quindi è istantaneo, ma le facce fra due blocchi pieni **non
esistono** — non sono mai state costruite, perché non si vedrebbero — quindi
sotto il taglio non c'è niente da mostrare e si vede il cielo. Per le
costruzioni (che sono cave) funziona benissimo, ed è per quello che serve. Per
sezionare davvero una collina ci sono due strade: ricostruire la geometria a
ogni spostamento del cursore (qualche secondo: pessimo per un cursore), oppure
tappare il taglio con lo stencil buffer (c'è un esempio ufficiale di three.js,
`webgl_clipping_stencil`; il diorama è un solido chiuso, quindi funzionerebbe).
Ho preferito dirlo nell'interfaccia piuttosto che far sembrare un bug una
scelta.

**Gli angoli delle scale sono dritti.** Le forme `inner_left`/`outer_right`
della proprietà `shape` non sono lette: la sagoma di una scalinata è giusta,
l'incavo dell'angolo no. `shape` è già in `SHAPE_PROPS`, quindi il dato arriva
fino a `classifyName` — manca solo scriverne la geometria.

**Le chiome sono piene.** Vedi §7: le foglie hanno una texture bucata ma la
chioma è disegnata come un guscio, quindi i buchi mostrerebbero il cielo. Il
riempimento costa zero facce; la resa "fancy" del gioco ne costerebbe il doppio
in un bosco.

**Il volume viene trasferito alla pagina.** Serve al mirino, che deve dire che
blocco sta guardando decine di volte al secondo senza fare un giro di messaggi.
La conseguenza è che il worker **non ha più il volume** dopo il caricamento: se
vuoi ricostruire la geometria (per il taglio vero, o per un filtro dei blocchi
applicato senza rileggere), devi decidere chi lo tiene. La strada più pulita è
lasciarlo al worker e spostare lì anche il mirino, rendendolo asincrono: a otto
aggiornamenti al secondo non si nota.

**Una mesh per colonna di chunk.** Sono 256 mesh per una porzione grande, cioè
altrettanti disegni. Si potrebbero accorpare, ma allora il frustum culling
lavorerebbe peggio e ricostruire un pezzo diventerebbe più caro. A 5,6 ms per
fotogramma non è il collo di bottiglia.

---

## 11. Se lo vuoi far crescere

In ordine di rapporto fra quello che si guadagna e quello che costa:

1. **Le facce nascoste dei blocchi non-cubo.** Adesso `emitBox` scarta una
   faccia solo se è a filo della parete della cella e il vicino è un cubo
   pieno. Due lastre affiancate disegnano le facce che si toccano. Non si vede,
   ma sono quadrilateri buttati via.
2. **Angoli delle scale** (§9): il dato c'è già, manca la geometria.
4. **`waterlogged`.** Una scala o una lastra sott'acqua adesso non ha l'acqua
   intorno. Basta aggiungere la proprietà a `SHAPE_PROPS` e far emettere al
   mesher anche il cubo d'acqua.
5. **Entità e block entity**: le insegne con il loro testo, i quadri, i mob.
6. **Il taglio vero** con lo stencil (§10).
7. **Ricaricare senza rileggere.** Se il volume resta al worker, cambiare
   filtro dei blocchi o taglio costa solo la ricostruzione della geometria.
8. **Le texture animate.** Acqua, lava e fuoco sono strisce di fotogrammi e ne
   usiamo il primo. Animarle vuol dire aggiornare lo strato dell'array a ogni
   fotogramma, o tenerli tutti e far scorrere l'indice nello shader.
9. **Portare in 3D quello che disegni sulla mappa.** Oggi il pulsante 🧊
   porta il *centro* della vista; i layer dell'Atlante — strade, aree,
   stazioni — restano di là. Un'area disegnata potrebbe diventare direttamente
   la porzione da caricare, invece del quadrato centrato a mano.

*(Il punto che stava qui — «rientrare in Cube-Atlas come terza scheda» — è
stato fatto: è questa.)*

---

## 12. Mappa dei file

| file | cosa fa | tocco? |
|---|---|---|
| `web/js/core/*.js` | lettura NBT, regioni, dimensioni, colori | **no**, viene da Cube-Atlas |
| `web/js/voxel/blockKinds.js` | stato del blocco → forma | sì, per le forme |
| `web/js/voxel/volume.js` | scatola di mondo → `Uint16Array` | raramente |
| `web/js/voxel/mesher.js` | forme → triangoli | sì, con attenzione (§6) |
| `web/js/pack/zip.js` | legge un .jar/.zip senza scompattarlo | raramente |
| `web/js/pack/resources.js` | stato del blocco → texture delle facce | sì, per i casi che non risolve |
| `web/js/pack/textures.js` | texture → array di strati | raramente |
| `web/js/worker3d.js` | i quattro handler, fuori dal thread dell'interfaccia | sì |
| `web/js/app/engine3d.js` | client del worker: promesse, progresso, stream | raramente |
| `web/js/app/viewer3d.js` | scena, telecamera in orbita, mirino, HUD, materiali | sì |
| `web/js/app/atlas3d.js` | Editor: porzione, anteprima, caricamento, cablaggio | sì |
| `web/js/app/glbReader.js` | Lettura: apre un `.glb` da disco e lo mostra | sì |
| `web/vendor/GLTFLoader.js` | il lettore glTF di three.js (MIT) | solo per aggiornare |
| `web/js/export/glb.js` | la porzione come modello glTF binario | sì |
| `web/js/app/packPicker.js` | scelta del .jar / resource pack | sì |
| `web/js/core/source.js` | accesso al salvataggio, `HttpSource` compresa | no, è condiviso con la mappa |
| `web/index.html` (`#screen-atlas3d`), `web/css/atlas3d.css` | interfaccia | sì |
| `web/js/app/main.js` | il ponte: scheda, pulsante 🧊, getter del mondo | sì |
| `web/vendor/three.module.js` | three.js r169 (MIT) | solo per aggiornare |
| `tools/serve.js` | server statico + mondo di sviluppo via HTTP | sì |
| `test/run-tests.js` | i 129 test, 57 dei quali qui | sì, sempre |
| `test/make-showcase-world.js` | mondo vetrina delle forme | sì, quando aggiungi forme |
| `test/make-zip.js` | zip costruiti a mano per i test | raramente |
| `test/make-test-world.js`, `nbt-write.js`, `node-source.js` | mondo di terreno e appoggi | no, sono di tutta la suite |
| `data/` | mondi generati — rigenerabili, ignorati da git | — |
