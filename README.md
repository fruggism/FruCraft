# Cube-Atlas

Un'app **locale** per disegnare la mappa del tuo mondo Minecraft Java Edition,
annotarla a layer come una mappa topografica, esportarla — e tenere l'archivio
scritto del tuo impero, esportabile come libro di Minecraft.

Tutto gira sul tuo computer: il server ascolta solo su `127.0.0.1`, il mondo
viene letto dai file di salvataggio e niente esce dalla macchina.

---

## Cosa fa

**1. Rende la mappa del mondo (come unMINED)**

Legge direttamente i file di regione `.mca` del salvataggio e disegna la mappa
vista dall'alto: colore del blocco di superficie, tinta per bioma (erba,
fogliame e acqua cambiano come in gioco), ombreggiatura del rilievo e acqua
scurita in base alla profondità. La mappa è navigabile con zoom continuo grazie
a una piramide di tile messa in cache su disco.

**2. Editor a layer**

Sopra la mappa crei quanti layer vuoi, di tre tipi:

| Tipo | Cosa disegna | Stile personalizzabile |
|---|---|---|
| **Strade** | tracciati a vertici successivi | colore, spessore, tratteggio (continuo / tratteggiato / punteggiato / tratto-punto), colore e spessore del bordo (abbinamento a due colori), nome |
| **Punti di interesse** | un simbolo sul punto | forma (cerchio, quadrato, triangolo, rombo, stella, segnaposto), colore, dimensione, categoria, descrizione |
| **Aree** | poligoni chiusi che delimitano zone | colore e opacità del riempimento, colore/spessore/tratteggio del bordo |

Ogni elemento si può **rinominare, descrivere, ristilizzare, spostare** (i punti
si trascinano, i vertici di strade e aree si spostano con *Modifica nodi*) ed
**eliminare**. Passando il mouse sopra un elemento compare il suo nome con le
informazioni; il nome può anche restare sempre visibile sulla mappa.

I layer si mostrano e nascondono singolarmente, si rinominano e si eliminano.

**3. Export e riapertura**

- **PNG** — mappa e layer appiattiti in un'immagine
- **SVG** — vettoriale, con **un gruppo per layer** (apribile in Inkscape/Illustrator)
- **GeoJSON** — solo i dati, con stile e proprietà
- **Progetto `.cubeatlas.json`** — tutto (layer, elementi, stili, documenti):
  si riapre con **Importa** mantenendo i layer

L'export copre la vista attuale oppure tutto il mondo generato.

**4. Archivio**

Una seconda schermata per scrivere i documenti del tuo impero. Ogni documento
si vede in anteprima impaginato come un libro di Minecraft e si esporta come:

- comando `/give` (formato **1.20.5+** o **1.20.4 e precedenti**)
- file `.mcfunction`
- testo `.txt`

L'interfaccia è in stile Minecraft, con texture pixel generate proceduralmente.

---

## Requisiti

- **Node.js 18 o successivo**
- Un mondo **Minecraft Java Edition 1.13 o successivo**

> Le versioni 1.13–1.17 sono lette, ma la tinta per bioma si applica solo dalla
> 1.18 in poi (prima i biomi erano salvati come id numerici). I mondi
> anteriori alla 1.13 non hanno la palette dei blocchi e non sono supportati.
> Bedrock Edition non è supportata (usa un formato diverso).

## Installazione e avvio

```bash
npm install
npm start
```

Poi apri **http://127.0.0.1:5173** nel browser.

Per cambiare porta: `PORT=8080 npm start`.

## Come si usa

1. **Mondo** — incolla il percorso della cartella del salvataggio (quella che
   contiene `level.dat`). Se Cube-Atlas trova i mondi nelle posizioni standard
   te li propone già in elenco. Premi *Analizza mondo*, scegli la dimensione
   (Overworld / Nether / End) e crea l'atlante.
2. **Layer** — seleziona un layer (o creane uno con `+ Strade`, `+ Punti`, `+ Aree`).
3. **Strumenti** — *Disegna* per aggiungere un elemento, *Seleziona* per
   sceglierlo, *Modifica nodi* per spostarne i vertici, *Cancella* per
   eliminarlo cliccandolo. `Esc` annulla, `Canc` elimina l'elemento selezionato.
4. **Proprietà** — nome, descrizione e stile dell'elemento selezionato.
5. **Esporta** — PNG, SVG, GeoJSON o il progetto completo.
6. **Archivio** — scrivi i documenti e copia il comando `/give`.

Il salvataggio è **automatico** (e viene forzato anche se chiudi la scheda
subito dopo una modifica).

### Dove trovo la cartella del mondo?

- **Windows** — `%APPDATA%\.minecraft\saves\NomeMondo`
- **macOS** — `~/Library/Application Support/minecraft/saves/NomeMondo`
- **Linux** — `~/.minecraft/saves/NomeMondo`

## Se cambi il mondo in gioco

I tile renderizzati restano in cache. Dopo aver costruito qualcosa premi
**Rigenera mappa (svuota cache)** per rileggere il salvataggio.

> Conviene chiudere Minecraft (o almeno uscire dal mondo) prima di rigenerare:
> i chunk non ancora salvati su disco non possono essere letti.

---

## Struttura del progetto

```
server.js                 server Express locale (API + file statici)
lib/
  nbt.js                  lettore/scrittore NBT (gzip, zlib, non compresso)
  anvil.js                file di regione .mca, sezioni, palette, biomi
  blockColors.js          colori dei blocchi + tinte per bioma
  tiler.js                piramide di tile con cache su disco
  worldScan.js            riconoscimento del mondo, limiti, level.dat
  projects.js             progetti: layer, elementi, documenti
  book.js                 impaginazione e comandi /give per i libri
public/
  index.html              le due schermate (Atlante / Archivio)
  css/style.css           tema Minecraft
  css/textures.css        texture pixel generate (data URI)
  js/core.js              stato condiviso, client API, dialog, salvataggio
  js/atlas.js             mappa, layer vettoriali, strumenti, export
  js/archive.js           documenti e anteprima libro
  js/main.js              avvio e collegamento dei controlli
tools/make-textures.js    genera le texture pixel
test/
  make-test-world.js      mondo sintetico di prova (non serve Minecraft)
  run-tests.js            suite di test
```

### Come funzionano le coordinate

Una sola convenzione attraversa tutto il progetto: **le coordinate sono blocchi
Minecraft `[x, z]`**, mai pixel. Leaflet usa `CRS.Simple` con `lng = x` e
`lat = -z`, così il nord è in alto e allo zoom `0` un blocco è un pixel. Per
questo un progetto resta valido a qualsiasi zoom e i dati esportati sono
direttamente confrontabili con le coordinate che leggi in gioco con F3.

## Test

```bash
npm test
```

La suite genera un mondo sintetico (colline, fiume, lago, spiagge, vetta
innevata, biomi diversi) e verifica NBT, bit-packing delle palette, lettura del
mondo, colori/biomi, tile e piramide di zoom, e l'export dei libri. Non serve
avere Minecraft installato.

```bash
npm run world      # rigenera solo il mondo di prova
npm run textures   # rigenera le texture dell'interfaccia
```

### Una nota sul bit-packing

È il punto in cui è più facile sbagliare leggendo i salvataggi: fino alla
**1.15** gli indici della palette sono impacchettati fitti e un valore può
essere spezzato tra due `long`; dalla **1.16** ogni `long` è riempito solo per
`floor(64 / bit)` valori e nessun valore attraversa il confine. Cube-Atlas
sceglie il lettore giusto in base al `DataVersion` del chunk, e i test
verificano che i due schemi non coincidano.
