# Router AI

Una chat che **sceglie da sola a quale AI chiedere**. Prima prova i modelli
gratuiti, e usa quelli a pagamento (le tue chiavi API, a consumo) solo come
riserva.

Gira sul tuo computer. Le chiavi stanno in un file `.env` locale e non
arrivano mai al browser né a GitHub.

## Come sceglie

1. **Capisce che tipo di task è**: `veloce`, `codice`, `ragionamento`,
   `scrittura` o `documenti`. Lo decide un modello gratuito e rapido (di solito
   Llama su Groq). Per i messaggi brevi, o se nessun modello è disponibile,
   bastano delle regole a parole chiave.
2. **Prende il primo modello disponibile** della lista di quella categoria.
   Le liste mettono prima i gratuiti.
3. **Se un modello dà errore** (quota del piano gratuito finita, chiave
   sbagliata, servizio giù) passa al successivo e lo mette in pausa per un po'.
   Nella chat vedi chi ha risposto, perché, e chi è stato saltato.

Puoi sempre scegliere un modello a mano dal menu in alto, oppure attivare
**Solo gratis** per non spendere mai nulla.

## Come si avvia

Serve [Node.js](https://nodejs.org) 20.3 o più recente. Non c'è niente da
installare.

```sh
cd ai-router
cp .env.example .env      # poi apri .env e incolla le chiavi che hai
npm run check             # prova ogni modello e dice cosa funziona
npm start                 # apri http://localhost:8787
```

## Dove prendere le chiavi

Ne basta una per cominciare. Per il router conviene **Groq** (classificatore
velocissimo) più **Gemini** (il più capace tra i gratuiti).

| Fornitore | Costo | Dove |
|---|---|---|
| Google Gemini | piano gratuito | https://aistudio.google.com/apikey |
| Groq | piano gratuito | https://console.groq.com/keys |
| OpenRouter | modelli `:free` gratuiti, gli altri a credito | https://openrouter.ai/keys |
| Mistral | piano gratuito «Experiment» | https://console.mistral.ai/api-keys |
| Ollama | gratis, gira sul tuo PC | https://ollama.com/download |
| Anthropic (Claude) | a consumo | https://console.anthropic.com/settings/keys |
| OpenAI (GPT) | a consumo | https://platform.openai.com/api-keys |

> **Attenzione:** gli abbonamenti Claude Pro e ChatGPT Plus/Pro **non includono**
> le API. Le chiavi API di Anthropic e OpenAI si ricaricano a parte e si pagano
> a consumo.
>
> Sui piani gratuiti i fornitori possono usare i messaggi per migliorare i
> loro modelli. Non incollarci dati sensibili.

## Personalizzare

Tutto si regola in [`config.js`](config.js):

- **l'ordine dei modelli** per ogni categoria (chi viene provato per primo);
- **`limiteGiorno`** su un modello, per smettere di usarlo dopo N richieste al
  giorno e restare dentro il piano gratuito;
- **i nomi dei modelli**: cambiano spesso. Se `npm run check` segnala un
  modello inesistente, ti mostra i nomi che il fornitore offre oggi;
- **nuove categorie** e nuovi fornitori compatibili con l'API di OpenAI.

Altre opzioni nel `.env`: `SOLO_GRATIS=1`, `CLASSIFICATORE=regole` (niente
chiamata in più per classificare), `PORT`.

Il pulsante **Modelli e uso** mostra quali fornitori sono attivi, lo stato di
ogni modello e quante richieste ha fatto ciascuno negli ultimi 14 giorni. Lo
storico sta in `data/uso.json`.

## Test

```sh
npm test
```
