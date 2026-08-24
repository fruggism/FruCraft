# Cube-Atlas

Disegna la mappa del tuo mondo Minecraft Java Edition, annotala a layer come
una mappa topografica, esportala — e tieni l'archivio scritto del tuo impero,
esportabile come libro di gioco.

**Gira interamente nel browser.** Niente da installare, niente server, e
soprattutto: il salvataggio **non viene caricato da nessuna parte**. La pagina
legge la cartella del mondo sul tuo computer e fa tutto lì, anche quando l'app
è aperta da un indirizzo web.

## Editor e Lettore

L'app è divisa in due, cambiabile dai due bottoni in alto:

- **✏️ Editor** — dove si fa tutto il lavoro: apri il mondo, disegni la mappa
  a layer, scrivi i documenti dell'Archivio. Richiede il mondo Minecraft.
- **📖 Lettore** — un visualizzatore leggero per i file che l'Editor ha già
  esportato. Non serve nessun mondo: è pensato per chi deve solo *guardare*
  quello che hai fatto, anche su un altro computer.

Entrambi hanno le stesse due sezioni, **Atlante** e **Archivio** — nell'Editor
sono dove crei le cose, nel Lettore dove le apri e le guardi:

- **Atlante** (Lettore) — apri un atlante esportato con *"🗺️ Esporta
  atlante"* (file "<i>nome-mondo</i>_ATLAS"): il terreno è un'immagine
  piatta, ma i layer restano vivi: si possono ancora nascondere/mostrare
  uno per uno, e passandoci sopra col mouse se ne vedono le informazioni,
  come nell'Editor.
- **Archivio** (Lettore) — apri un documento esportato dall'Archivio
  dell'Editor e leggilo impaginato.

---

## Come si apre

**Da un indirizzo (consigliato).** Apri il link dell'app in Chrome o Edge. Se
vuoi averla come applicazione sul Mac, dalla barra degli indirizzi scegli
*Installa Cube-Atlas*: finisce nel dock con la sua icona, si apre in una
finestra sua e funziona anche senza rete.

**In locale, dal repository.** Serve solo Node (nessuna dipendenza da
installare):

```bash
npm run web        # poi apri http://127.0.0.1:5173
```

Qualunque altro server statico va bene, per esempio `python3 -m http.server`
dentro la cartella `web/`.

> Un doppio clic diretto su `web/index.html` **non** funziona: da `file://` il
> browser blocca i Web Worker e l'archiviazione locale, che sono ciò su cui
> l'app si regge. Serve un indirizzo `http://` o `https://` — anche locale.

## Requisiti

- **Chrome o Edge** per l'esperienza piena (il browser ricorda la cartella del
  mondo). Su **Safari** e **Firefox** funziona tutto, ma la cartella va
  riselezionata a ogni avvio.
- Un mondo **Minecraft Java Edition 1.13 o successivo**.
- Su **iPad**, Safari resta l'unico browser disponibile: non ho modo di
  verificare da qui se la versione di iPadOS installata lascia scegliere
  un'intera cartella (invece che singoli file) dal selettore che compare
  toccando *"Scegli la cartella del mondo…"* — va provato. Se non funziona,
  fammelo sapere: è l'unico punto dell'app che dipende da una funzione del
  browser fuori dal mio controllo.

> Le versioni 1.13–1.17 sono lette, ma la tinta per bioma si applica dalla 1.18
> in poi (prima i biomi erano id numerici). I mondi anteriori alla 1.13 non
> hanno la palette dei blocchi e non sono supportati. Bedrock Edition usa un
> formato diverso e non è supportata.

## Come si usa

1. **Mondo** — *Scegli la cartella del mondo…* e indica la cartella del
   salvataggio (quella con dentro `level.dat`). Se ne indichi una che contiene
   più mondi, l'app ti chiede quale. Poi scegli la dimensione.
   - **Filtro blocchi**: prima di creare l'atlante, apri questa tendina per escludere
     dal disegno blocchi come le barriere, che altrimenti apparirebbero come pareti
     inesistenti — il tile mostra quello che c'è sotto. Scegliendolo qui, l'atlante
     nasce già con il filtro attivo, senza dover rigenerare nulla dopo. Si può
     cambiare anche più tardi, ma in quel caso le parti già generate vanno
     rigenerate (*Svuota cache e rigenera*, nella 🧭 in fondo alla mappa) per aggiornarsi.
   Poi crea l'atlante: la mappa si genera da sola intorno al punto di spawn,
   senza altro da fare — lo stato di avanzamento compare nella 🧭 (vedi sotto).
2. **La mappa** — in basso a sinistra c'è sempre la coordinata sotto il
   cursore, e accanto una **🧭 bussola**: apre un pannellino con dove vuoi
   andare (coordinate, punto di spawn, tutto il mondo), se mostrare il
   terreno e le ferrovie (cercate a tutte le altezze, più scure quanto più
   sono in basso), e la manutenzione della cache dei tile (*Svuota cache e
   rigenera* per questo mondo, o *Svuota la cache di tutti i mondi* per
   liberare spazio nel browser).
3. **Layer** — creane quanti vuoi, di cinque tipi:

| Tipo | Cosa disegna | Stile |
|---|---|---|
| **Strade** | tracciati a vertici successivi, estendibili in un secondo momento | colore, spessore, tratteggio, colore/spessore del bordo, nome |
| **Trasporti** | linee di trasporto pubblico (metro, bus…), anche adiacenti fra loro | colore, spessore, tratteggio, colore/spessore del contorno (facoltativo, come le strade), **stazioni condivise**: una stazione collegata a più linee fa fermare tutte allo stesso punto |

   Disegnando una linea di trasporto, gli angoli scattano ogni 45°, passare
   sopra una stazione esistente vi si aggancia automaticamente, e tornare col
   disegno sul punto di partenza chiude la linea ad anello e la conclude da
   sola. Se due linee corrono per un tratto sullo stesso percorso, l'app le
   affianca in automatico (un avviso lo segnala) invece di sovrapporle in un
   unico tratto indistinguibile. Le stazioni sono elementi indipendenti dalle
   linee: quando un layer trasporti è selezionato, gli **Strumenti**
   guadagnano *"🚉 Nuova stazione"* (subito sotto i quattro strumenti
   principali — ne pianta una prima ancora che qualunque linea ci passi) e
   *"Simbolo delle stazioni"* (forma — cerchio, quadrato o rettangolo — e
   dimensione per l'intero layer; per default piccoli pallini, per non
   sovrastare le linee). Una stazione con due o più linee diventa un'icona
   allargata con una striscia colorata per ogni linea, nella forma scelta.
   Selezionandone una con *Seleziona* si apre il suo editor: nome,
   descrizione e — spuntando *"Simbolo personalizzato per questa
   stazione"* — una forma e una dimensione solo per lei, senza cambiare il
   default del layer. Selezionando invece una linea, le sue Proprietà
   includono l'elenco di ogni linea del layer con le sue fermate in ordine —
   compare da solo, senza doverlo aprire a parte. Il nome di una linea non
   compare mai sulla mappa (resta visibile al passaggio del mouse, e
   nell'elenco): con più linee
   vicine affiancate automaticamente sarebbe solo confusione. Selezionando
   un layer trasporti si apre anche *"Linee visibili"*, un elenco con una
   casella per linea per mostrarne solo alcune sulla mappa.
| **Punti di interesse** | un simbolo sul punto | forma, colore, dimensione, categoria (abitazione, negozio, istituzioni, fiume, montagna, lago…), descrizione |
| **Note** | promemoria sulla mappa, per le cose da costruire | colore, dimensione, descrizione libera |
| **Aree** | poligoni chiusi che delimitano zone | colore e opacità del riempimento, colore/spessore/tratteggio del bordo |

   Ogni layer può avere **sublayer** (il ➕ sulla riga): utile per elenchi come
   *regione › provincia › quartiere*, con *strade*/*trasporti*/*punti* annidati
   dentro. Nascondere un layer nasconde anche i suoi sublayer. Il 🗑 sulla riga
   elimina un layer (i suoi sublayer restano, spostati al livello superiore).
4. **Strumenti** — *Disegna* per aggiungere, *Seleziona* per scegliere,
   *Modifica nodi* per spostare i vertici, *Cancella* per eliminare cliccando.
   `Esc` annulla, `Canc` elimina l'elemento selezionato. I punti si spostano
   trascinandoli. Passando il mouse su un elemento compaiono le sue
   informazioni; il nome può restare sempre visibile sulla mappa, e la sua
   etichetta si trascina dove preferisci: se la allontani troppo dal punto a
   cui appartiene compare una sottile linea nera che li ricollega. Ogni
   elemento può avere un **banner** (un'immagine PNG/JPEG/WebP caricata dal
   proprietà), piantato come una bandierina sulla mappa e nell'anteprima al
   passaggio del mouse.
5. **Esporta mappa** — tre formati, tutti con un'area da scegliere prima:
   vista attuale, tutto il mondo generato, oppure disegnata a mano sulla
   mappa (utile per un ritaglio preciso, tipo solo la propria città). Ogni
   file inizia col nome del mondo, non dell'atlante (che è libero di
   chiamarsi come vuoi):
   - **🗺️ Esporta atlante** (`nome-mondo_ATLAS.camap.json`) — pensato per il
     Lettore: il terreno è un'immagine piatta (ha senso, sono blocchi), ma i
     layer restano dati veri. Nel Lettore si possono ancora
     nascondere/mostrare uno per uno, e passando il mouse su un elemento se
     ne vedono le informazioni — come nell'Editor.
   - **📐 Esporta layer SVG** (`nome-mondo_ATLAS_layer.svg`) — vettoriale, un
     gruppo per layer, apribile in Inkscape/Illustrator.
   - **Immagine PNG** — un'unica immagine piatta con *tutto* disegnato sopra,
     layer compresi: comoda da condividere o stampare, ma senza interattività.

   Le esportazioni con immagine (PNG e l'atlante) riducono da sole la
   risoluzione quando l'area è enorme — tipicamente "tutto il mondo generato"
   su una partita esplorata a macchia di leopardo, con una regione sperduta
   lontanissima dal resto — così il file resta sempre apribile invece di
   uscire come un'immagine rotta. Lo stato di esportazione lo segnala quando
   succede.
6. **Archivio** — scrivi i documenti del tuo impero, vedili impaginati come un
   libro di Minecraft ed esportali come comando `/give` (formato 1.20.5+ o
   precedenti), file `.mcfunction` o testo. *"📖 Esporta per il Lettore"*
   salva invece un file `.cadoc.json` pensato per essere aperto nel Lettore:
   stessa suddivisione in pagine, ma pensata per leggere a schermo, non per
   il limite delle pagine di un libro di Minecraft.

   **L'Archivio è indipendente dagli atlanti**: si scrive senza aver aperto
   (o anche senza avere) un mondo o un progetto. Ogni documento è una
   *versione firmata*: quando lo crei, ti viene chiesto solo chi lo scrive —
   il codice univoco e la data si generano da soli — e da quel momento
   codice, data e firma non si possono più cambiare. Il titolo e il
   contenuto restano modificabili finché quella versione è l'ultima; nel
   momento in cui scegli *"🧬 Crea nuova versione"* per riprendere in mano un
   documento, quello vecchio si blocca in sola lettura (con un avviso in
   corsivo) e la nuova versione — firmata di nuovo, con la sua data — parte
   editabile al suo posto. Niente viene mai sovrascritto: la cronologia
   resta tutta nell'elenco a sinistra, versioni bloccate incluse (🔒).

Il salvataggio è automatico: atlanti e documenti stanno nell'archiviazione
locale del browser. Usa *Esporta .json* per averne una copia tua.

### Modalità iPad

Il selettore *Interfaccia* nell'intestazione (🖥️ Desktop / ✏️ iPad) cambia
com'è pensata l'interazione, non solo la disposizione — un iPad in verticale
si adatta già da solo (il pannello si stringe sotto la mappa sotto i 900px),
ma restava pensato per un mouse: informazioni che compaiono solo al
passaggio del cursore, maniglie per i vertici pensate per un click preciso.
La modalità iPad, salvata e riletta a ogni apertura:

- ingrandisce ogni bersaglio toccabile (pulsanti, tab, caselle, cursori,
  le maniglie di "Modifica nodi") ad almeno 44px, la misura minima
  consigliata da Apple stessa per un tocco;
- mostra le informazioni di un elemento al primo tocco, invece che al solo
  passaggio — con una penna (o un dito) non esiste un "passaggio" prima del
  tocco;
- aggiunge un pulsante ☰ per nascondere il pannello laterale e disegnare
  a schermo intero, utile su uno schermo piccolo mentre si traccia con
  precisione;
- **raddrizza le aree**: disegnando un poligono a mano libera (layer
  *Aree*) con la penna, l'app lo *"raddrizza"* appena finito — ripulisce il
  tremore della mano, allinea i lati agli assi e li squadra, così un
  edificio disegnato a mano viene fuori con gli angoli dritti invece che
  storto. Succede solo in modalità iPad: un poligono disegnato con il
  mouse non viene mai toccato.

### Dove trovo la cartella del mondo?

- **macOS** — `~/Library/Application Support/minecraft/saves/NomeMondo`
- **Windows** — `%APPDATA%\.minecraft\saves\NomeMondo`
- **Linux** — `~/.minecraft/saves/NomeMondo`

Le cartelle delle regioni vengono cercate dentro il salvataggio, quindi
funzionano sia il layout classico (`region/`, `DIM-1/`, `DIM1/`) sia quelli in
cui i file stanno più in profondità, come `dimensions/minecraft/overworld/region/`.

## Quanto ci mette

Non c'è più un pulsante "Genera mappa" da premere: appena crei un atlante, la
mappa si genera da sola intorno al punto di spawn (un raggio di 1024 blocchi,
di solito pochi secondi) — lo stato compare nella 🧭 in basso a sinistra sulla
mappa. Un tile di dettaglio copre 256×256 blocchi e richiede meno di un
secondo l'uno.

## Se cambi il mondo in gioco

I tile restano in cache nel browser. Dopo aver costruito qualcosa apri la 🧭 e
premi **Svuota cache e rigenera**.

> Conviene uscire dal mondo in Minecraft prima di rigenerare: i chunk non
> ancora salvati su disco non possono essere letti.

**Svuota cache e rigenera** riguarda solo il mondo aperto in quel momento —
i tile degli altri mondi che hai mappato in passato restano dov'erano. La
stessa 🧭 mostra anche quanto spazio sta usando l'app nel browser
(soprattutto tile) e un pulsante separato, **🗑️ Svuota la cache di tutti i
mondi**, che cancella i tile di *ogni* mondo mappato finora per liberare
spazio — utile perché quella cache non si svuota mai da sola. Non tocca gli
atlanti salvati (layer, punti, linee…): quelli restano finché non li elimini
esplicitamente da *"2 Progetto"*, ed è per questo che, se ti serve tenere una
copia della mappa, conviene esportarla (*"5 Esporta mappa"*, o *"Esporta
.json"* per il progetto) invece di contare sulla cache dei tile.

---

## Struttura

```
web/                       l'applicazione: file statici, nessuna build
  index.html
  css/style.css            tema Minecraft
  css/textures.css         texture pixel generate (data URI)
  js/core/                 il motore, indipendente dall'ambiente
    nbt.js                 lettore NBT (decompressione nativa del browser)
    anvil.js               file di regione .mca, sezioni, palette, biomi
    blockColors.js         colori dei blocchi + tinte per bioma
    worldScan.js           ricerca delle cartelle region e delle dimensioni
    tiler.js               piramide di tile (pixel RGBA grezzi)
    renderJob.js           generazione della mappa, con avanzamento
    book.js                impaginazione e comandi /give
    source.js              accesso al salvataggio (cartella o elenco file)
  js/worker.js             il motore fuori dal thread dell'interfaccia
  js/app/                  interfaccia: mappa, layer, archivio, storage
    main.js                app shell: cambio modalità (Editor/Lettore) e schermata
    atlas.js                schermata Atlante: mappa, layer, disegno, export
    archive.js               schermata Archivio: interfaccia ed export libri
    documents.js             modello dei documenti: indipendenti, versionati e firmati
    reader.js                schermata Lettore: apre mappe e documenti già esportati
tools/
  serve.js                 server statico per lo sviluppo
  make-textures.js         genera le texture (con encoder PNG incluso)
test/
  run-tests.js             suite di test
  make-test-world.js       mondi sintetici di prova
```

Il progetto **non ha dipendenze**: `npm test` e `npm run web` funzionano su una
copia appena clonata, senza `npm install`. Leaflet è incluso in `web/vendor/`.

### Come funzionano le coordinate

Una sola convenzione attraversa tutto: **le coordinate sono blocchi Minecraft
`[x, z]`**, mai pixel. Leaflet usa `CRS.Simple` con `lng = x` e `lat = -z`,
così il nord è in alto e allo zoom `0` un blocco è un pixel. Per questo un
progetto resta valido a qualsiasi zoom e i dati esportati sono confrontabili
con le coordinate che leggi in gioco con F3.

### Perché un Web Worker

Aprire una regione e dipingerne i tile è lavoro pesante: sul thread
dell'interfaccia bloccherebbe lo scorrimento e il disegno. Tutto ciò che legge
il salvataggio vive quindi in `js/worker.js`, e i tile tornano alla pagina come
`ImageBitmap`, trasferiti invece che copiati.

### Perché la mappa si genera in background

Un tile panoramico (zoom −6) copre 16 384 blocchi per lato: costruirlo
ricorsivamente vuol dire produrre 4096 tile di dettaglio, decine di minuti di
lavoro. Farlo mentre si serve un tile significa, in pratica, una mappa che non
compare mai. Quindi: nell'immediato si renderizza solo ciò che è economico
(zoom 0 e −1) e il resto si compone da ciò che è già in cache, mentre la
piramide completa la produce il job in background. In più, l'elenco dei file di
regione permette di rispondere «qui non c'è niente» senza leggere nulla, ed è
ciò che rende scorrevole un mondo esplorato a macchia di leopardo.

### Una nota sul bit-packing

È il punto in cui è più facile sbagliare leggendo i salvataggi: fino alla
**1.15** gli indici della palette sono impacchettati fitti e un valore può
essere spezzato fra due `long`; dalla **1.16** ogni `long` è riempito solo per
`floor(64 / bit)` valori e nessun valore attraversa il confine. Cube-Atlas
sceglie il lettore in base al `DataVersion` del chunk, e i test verificano che
i due schemi non coincidano — sbagliando, la mappa uscirebbe plausibile ma con
i blocchi sbagliati.

## Test

```bash
npm test           # 68 test, nessuna dipendenza
npm run world      # rigenera i mondi sintetici di prova
npm run textures   # rigenera le texture dell'interfaccia
```

Il motore in `web/js/core/` è scritto per non dipendere dall'ambiente: gli
serve solo una *sorgente* da cui leggere. Nel browser è la cartella scelta
dall'utente, nei test è il filesystem — quindi la suite prova esattamente il
codice che gira nel browser, senza browser.

## Pubblicazione

`.github/workflows/pages.yml` esegue i test su ogni branch e pubblica `web/` su
GitHub Pages dal branch predefinito del repository.

Pages va acceso una volta sola dal proprietario del repository:
**Settings → Pages → Source: GitHub Actions**. Il workflow non può farlo da sé —
GitHub non concede al token delle Actions il permesso di creare un sito Pages.
Da quel momento ogni push al branch predefinito aggiorna il sito.
