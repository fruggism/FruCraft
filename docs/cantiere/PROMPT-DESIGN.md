# Prompt per Claude Design — Cube-Atlas **Cantiere**

> Copia tutto quello che c'è sotto la riga in Claude Design. Se puoi, allega
> 2–3 screenshot dell'attuale Cube-Atlas (Atlante 2D con una mappa aperta) e
> qualche icona da `web/img/icons/` come riferimento di stile.

---

Disegna l'interfaccia di **Cube-Atlas Cantiere**, un'app desktop per **macOS**
che modifica mondi di Minecraft Java Edition guardandoli **dall'alto, come una
mappa 2D**. Pensala come un **Photoshop per mappe Minecraft**: un'area di
lavoro centrale con la mappa, gli strumenti a sinistra, le opzioni in alto, i
pannelli a destra. Deve restare **semplice**: pochi elementi, gerarchia
chiara, niente fronzoli.

## Chi la usa e cosa fa
È un giocatore esperto che vuole rimodellare il proprio mondo:

- ridipingere i biomi;
- tagliare, copiare e incollare porzioni di terreno, anche da un altro mondo,
  ruotandole e specchiandole;
- fondere i bordi di un pezzo incollato con il paesaggio intorno;
- levigare e rimodellare il terreno;
- sostituire blocchi in blocco;
- piantare o togliere vegetazione;
- tracciare fiumi e laghi;
- spostare lo spawn;
- gestire giocatori, regole di gioco e bordo del mondo;
- cercare blocchi;
- eliminare chunk inutili.

Le modifiche **restano in sospeso** finché non preme **Applica**, che le
scrive sempre in una **copia** del mondo. L'originale non si tocca mai: questa
sicurezza deve vedersi e rassicurare, senza diventare invadente.

Lingua dell'interfaccia: **italiano**.

## Struttura della finestra (dall'alto in basso)
1. **Barra del titolo macOS** (semafori) integrata nella prima riga.
2. **Schede delle impostazioni/menu** (prima riga): File · Modifica ·
   Selezione · Mondo · Vista · Impostazioni. Cliccando una scheda si apre
   sotto una striscia compatta di comandi con icona e testo, come un ribbon
   leggero e non quello pesante di Office.
3. **Schede dei mondi** (seconda riga): una scheda per ogni mondo aperto, come
   i documenti in Photoshop o le schede di Safari. Ogni scheda mostra:
   - il nome del mondo e un'iconcina della dimensione (Overworld / Nether /
     End);
   - un **pallino** se ci sono modifiche in sospeso;
   - una × per chiudere.

   Alla fine della riga c'è un "+" per aprire un altro mondo.
4. **Barra opzioni contestuale**: cambia con lo strumento attivo. Esempi:
   - pennello bioma → dimensione, bioma scelto, "tutta la colonna";
   - selezione → modalità aggiungi/sottrai, Y min/max.
5. **Area centrale**: la mappa dall'alto (pixel art di blocchi). Ha
   zoom, griglia dei chunk opzionale, selezioni con "formiche in marcia",
   anteprime semi-trasparenti e marcatori.
6. **Colonna strumenti a sinistra**, verticale, con **icona + testo** e
   gruppi separati da divisori:
   - **Naviga**: Sposta;
   - **Seleziona**: Rettangolo, Poligono, Lazo, Pennello di selezione;
   - **Modifica**: Bioma, Terreno (leviga/alza/abbassa/spiana/erodi),
     Vegetazione, Fiume e lago, Sostituisci;
   - **Mondo**: Spawn, Bordo del mondo, Giocatori, Cerca, Pota chunk.

   Quando uno strumento ha varianti, si aprono con un piccolo triangolo in
   basso a destra, come in Photoshop.
7. **Pannello a destra** comprimibile, con schede:
   - **Proprietà**: dello strumento o dell'oggetto selezionato;
   - **Appunti**: libreria dei pezzi salvati, con miniature dall'alto,
     dimensioni e tag, trascinabili sulla mappa;
   - **Cronologia**: l'elenco delle modifiche in sospeso, ciascuna
     annullabile;
   - **Risultati**: risultati della ricerca.
8. **Barra di stato in basso**:
   - coordinate X/Z e quota Y sotto il cursore, blocco e bioma, chunk e
     region, zoom;
   - uno **slider "quota di taglio"**, che mostra il mondo tagliato a una
     certa altezza per vedere grotte e interni;
   - a destra il contatore "12 modifiche in sospeso" e il pulsante primario
     **Applica**.

## Schermate e stati da disegnare
1. **Avvio senza mondi aperti**: elenco dei mondi trovati nella cartella
   `saves`, con miniatura, nome, versione, data di ultima modifica, più il
   pulsante "Apri altra cartella…". Mostra un mondo con versione troppo
   vecchia (sola lettura).
2. **Mondo aperto, strumento Sposta**: la vista di riferimento, con due
   schede di mondi aperte e una con il pallino.
3. **Selezione attiva** (poligono) con dimensioni e numero di blocchi, e
   intervallo Y nella barra opzioni.
4. **Incolla in corso**: fantasma semi-trasparente del pezzo sulla mappa, con
   maniglie e una mini-barra fluttuante vicino al pezzo:
   - Ruota ⟳;
   - Specchia ↔ e ↕;
   - Y ±;
   - "Appoggia sul terreno";
   - interruttori "Incolla aria" / "Entità" / "Biomi";
   - ✓ Conferma e ✕ Annulla.

   Includi anche il pannello della **fusione dei bordi**:
   - larghezza della fascia (slider);
   - intensità;
   - irregolarità;
   - "solo esterno / anche interno";
   - rimescola 🎲.

   Sulla mappa, la fascia di fusione si vede come un alone, e le
   **costruzioni protette** come zone tratteggiate.
5. **Pennello bioma**: cursore circolare, selettore di bioma cercabile con
   tessere colorate, mappa in "vista biomi" (colori piatti per bioma con
   legenda).
6. **Sostituisci**: dialogo/pannello a regole.
   - Ogni riga è "A → B": A è un blocco/tag/pattern, B un blocco o un **mix
     percentuale** mostrato come barra divisa a colori.
   - Filtri: intervallo Y, solo esposti all'aria, biomi.
   - Interruttore "mantieni proprietà".
   - Anteprima del conteggio: "48.210 blocchi".
7. **Cerca**: risultati in elenco nel pannello destro e marcatori sulla mappa.
8. **Spawn e level.dat**: lo spawn come marcatore trascinabile con raggio, e
   un pannello Mondo con regole di gioco (sì/no e numeri), ora del giorno
   (slider con sole e luna), meteo, bordo del mondo disegnato sulla mappa.
9. **Giocatori**: elenco con testa del personaggio, posizione sulla mappa,
   inventario a griglia 9×4 + armatura (in stile inventario, ma pulito) e il
   pulsante "Sposta qui…".
10. **Pota chunk**: heatmap del tempo trascorso nei chunk (`InhabitedTime`)
    sovrapposta alla mappa, chunk selezionati evidenziati, "Libera 312 MB".
11. **Applica**: dialogo con:
    - nome della copia (modificabile) e percorso;
    - riepilogo delle modifiche per tipo;
    - controlli verdi o rossi ("Minecraft è chiuso", "Spazio su disco ok");

    Poi uno stato di avanzamento per file e un report finale ("Copia creata
    — Apri la copia").
12. **Avviso Minecraft aperto** (session.lock occupato): stato di blocco
    chiaro e gentile.
13. **Impostazioni**: cartella `saves`, lingua, tema, prestazioni (worker,
    memoria), cartella degli appunti.

## Stile
- **Strumento professionale**, ordinato e leggibile. Il riferimento è un mix
  di Photoshop/Affinity (struttura) e app native macOS (rifinitura: tipografia
  di sistema SF Pro, angoli e ombre leggere, vibrancy dove ha senso).
- **Tema scuro di default** (la mappa colorata risalta su un'interfaccia
  neutra), più **tema chiaro**.
- L'identità di Cube-Atlas viene da Minecraft: l'app attuale usa icone in
  **pixel art 16×16** (blocco d'erba come logo, bussola, piccone, baule,
  matita, ecc.) e cornici a rilievo in stile inventario.
  - Nel Cantiere tieni le **icone pixel art** (renderizzate nitide, senza
    sfocatura) e al massimo qualche dettaglio a rilievo, per esempio sul
    pulsante Applica o sulle tessere dei blocchi.
  - Il resto deve restare piatto e moderno.
- Colori d'accento: un verde "erba" per le azioni primarie e lo stato
  "sicuro", un ambra per "in sospeso", un rosso per i blocchi. Le
  sovrapposizioni sulla mappa (selezione, fascia di fusione, protezione,
  ricerca) devono distinguersi chiaramente **sopra qualsiasi terreno**:
  - neve bianca;
  - oceano blu;
  - deserto giallo;
  - Nether rosso.

  Prevedi contorni doppi chiaro/scuro.
- Densità da strumento desktop: righe da 28–32 px, testo 12–13 px, colonna
  strumenti larga circa 150 px con le etichette (comprimibile a sole icone).
  Finestra di riferimento: MacBook 1440×900 e 1728×1117.

## Cosa consegnare
1. **Design system**:
   - token come variabili CSS (colori per tema scuro e chiaro, tipografia,
     spaziature, raggi, ombre, colori delle sovrapposizioni);
   - componenti: scheda, pulsante strumento, pulsante primario e secondario,
     campo, slider, interruttore, selettore di bioma/blocco, riga di regola,
     voce di cronologia, toast, dialogo, barra di avanzamento.
2. **Le schermate dell'elenco sopra**, in tema scuro; le 2–3 principali
   anche in tema chiaro.
3. **Note di consegna per lo sviluppo**:
   - misure;
   - stati (hover, attivo, disabilitato, focus);
   - comportamento dei pannelli comprimibili;
   - scorciatoie mostrate nei tooltip (⌘Z, ⌘C, ⌘V, R, ⇧H, ⇧V, B, M, ⌘↩);
   - cosa succede a finestra stretta.

L'app verrà costruita in Electron con HTML/CSS. Prepara token e componenti in
modo che si possano tradurre direttamente in CSS: niente effetti impossibili
sul web.
