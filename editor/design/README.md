# Design del Cantiere (approvato)

Esportato dal canvas di Claude Design "Cube-Atlas Cantiere"
(https://claude.ai/artifact/55we6dVYkwGq48pcZSB4cn). Il canvas resta la fonte:
se il design cambia, si riesporta qui.

## Cosa c'è
- `project/*.dc.html` — le tavole, in HTML/CSS. Sono "Design Component": HTML
  normale più un piccolo templating (`{{valore}}`, `<sc-for>`, `<sc-if>`,
  `<dc-import name="X">` = includi la tavola X) con i dati di esempio nello
  script `renderVals()` in fondo. Il CSS dentro `<helmet><style>` è quello vero
  da riprodurre.
  | Tavola | Cosa mostra |
  |---|---|
  | `DesignSystem` | colori dei due temi, sovrapposizioni sulla mappa, tipografia, spaziature, raggi, ombre, componenti e stati, **note di consegna** (misure, pannelli comprimibili, scorciatoie, finestra stretta) |
  | `Chrome` | barra superiore: menu a schede + ribbon dei comandi (contenuto per ogni menu) + schede dei mondi |
  | `Sidebar` | colonna strumenti con gruppi |
  | `StatusBar` | barra di stato: coordinate, quota di taglio, modifiche in sospeso, Applica |
  | `Main` | mondo aperto, strumento Sposta, tema scuro (con varianti `theme`/`mode`) |
  | `Selezione` | `Main` in tema chiaro con selezione poligono |
  | `Avvio` | nessun mondo aperto: elenco dei mondi, mondo troppo vecchio in sola lettura |
  | `Incolla` | incolla in corso, mini-barra di trasformazione, pannello fusione dei bordi |
  | `Sostituisci` | regole A → B con mix percentuali e filtri |
  | `Applica` | dialogo di conferma, avanzamento, copia creata |
- `project/map.svg` — mappa finta usata solo nei mockup.
- `tokens.css` — i token del design system trascritti come variabili CSS
  (scuro su `:root`, chiaro su `[data-theme="light"]`). Prende il posto di
  `editor/renderer/tokens.css`.
- `icons/*.svg` — le icone pixel art 16×16 estratte dalle tavole, una per file
  (`t-*` strumenti, `i-*` comandi, `d-*` dimensioni). Usano `currentColor` per
  la parte che segue il colore del testo: inseriscile inline o come `<symbol>`,
  non come `<img>`, altrimenti `currentColor` non funziona. Sempre
  `image-rendering: pixelated` / `shape-rendering: crispEdges`.

## Schermate del brief non disegnate
Il design non copre: pennello bioma con vista biomi, Cerca, pannello Spawn e
level.dat, Giocatori, Pota chunk, avviso "Minecraft aperto" (c'è solo come
toast), Impostazioni. Mancano anche le icone per alcuni comandi (vegetazione
rimuovi, salva negli appunti, esporta schematica…). Si costruiscono con gli
stessi componenti e token; dove serve un'icona nuova, disegnala nello stesso
stile (16×16 pixel art, `currentColor` + al massimo 1–2 colori d'accento).
