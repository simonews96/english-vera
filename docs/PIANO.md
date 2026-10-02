# Vera — piano di progetto

Versione 1, 2 ottobre 2026. **Stato: in attesa dell'approvazione dell'utente. Nessun codice applicativo è stato scritto.**

Vera è un tutor vocale di inglese personale: un'app statica su GitHub Pages, installabile sul telefono, che ascolta, risponde a voce in italiano e in inglese, corregge, ricorda e fa progredire un principiante assoluto italiano verso un inglese da viaggio in sei mesi, in sessioni da 5-10 minuti.

Le decisioni qui sotto poggiano su una ricerca fatta il 2 ottobre 2026 su fonti primarie (documentazione Anthropic, codice sorgente di Chromium e WebKit, documentazione GitHub e Apple), con verifica avversariale delle affermazioni critiche. Gli appunti, con fonti e livelli di confidenza, sono in `docs/ricerca/`.

---

## 1. Decisioni chiave

### 1.1 Cervello: API di Claude chiamata dal browser

**Funziona, verificato con test live il 2 ottobre 2026.** `api.anthropic.com` risponde con `Access-Control-Allow-Origin: *` quando la richiesta porta l'header `anthropic-dangerous-direct-browser-access: true`. L'SDK ufficiale TypeScript (`@anthropic-ai/sdk` 0.131, ESM, compatibile con Vite) aggiunge l'header con l'opzione `dangerouslyAllowBrowser: true`. È una funzione dichiarata nelle release notes Anthropic del 22 agosto 2024 e nella pagina dell'SDK TypeScript, stabile da due anni. Unica eccezione: organizzazioni con accordo Zero Data Retention (non un account personale) ricevono 401.

**Dove sta la chiave.** Solo in IndexedDB/localStorage del dispositivo, mai nel repository, mai inviata a terzi oltre ad Anthropic. L'app lo dice in chiaro nelle impostazioni. Consiglio operativo: creare nella Console Anthropic una chiave dedicata con scadenza (per esempio 90 giorni) e impostare un limite di spesa mensile in Settings > Billing.

**Modello predefinito: `claude-sonnet-5-5`**, con `thinking: { type: "between_tools" }`. Senza strumenti dichiarati, questa impostazione significa "nessun ragionamento prima della risposta": è il modo documentato per avere la prima parola più in fretta su Sonnet 5.5 (`disabled` restituisce 400). Configurabile dalle impostazioni:

| Modello | Perché | Note |
|---|---|---|
| `claude-sonnet-5-5` (predefinito) | Il migliore equilibrio tra velocità e qualità di insegnamento; $2 / $10 per milione di token | Thinking spento via `between_tools`; non inviare `temperature`, prefill o `tool_choice` forzato (400) |
| `claude-haiku-4-5` ("turbo") | Il più veloce ed economico ($1 / $5); thinking spento di default | Insegnante più debole; data minima di ritiro "non prima del 15 ottobre 2026", nessun ritiro annunciato: va ricontrollato |
| `claude-opus-5-5` ("qualità") | Qualità massima ($4 / $20) | Il thinking non si può spegnere: prima parola più lenta |

Il campo modello è una stringa modificabile: se un modello viene ritirato, non serve un nuovo deploy.

**Risposta strutturata in streaming.** Gli structured outputs sono GA (`output_config.format` con JSON schema, nessun header beta) e arrivano come testo in streaming. L'app accumula il JSON e, con un estrattore incrementale, fa partire la voce al primo segmento chiuso, senza aspettare la fine della risposta. Regole dello schema: `additionalProperties: false` ovunque, niente `minLength`/`pattern`, nessun campo chiamato `reasoning` o `thinking` (rischio di rifiuto per `reasoning_extraction`), `segments` come prima proprietà richiesta.

**Latenza: budget per restare sotto i due secondi** dalla fine del parlato all'inizio della voce di Vera:

| Tratto | Stima | Come la teniamo bassa |
|---|---|---|
| Risultato finale del riconoscitore dopo il silenzio | 300-800 ms | Profilo per piattaforma; su desktop chiusura del turno anche dal rilevatore di silenzio |
| Prima parola del modello | 500-1200 ms | Thinking spento, prompt caching sul system prompt, contesto piccolo (scheda studente ≤400 token + ultimi 8 turni) |
| Primo segmento JSON completo | 100-300 ms | `segments` per primo nello schema; primo segmento breve per contratto di prompt |
| Avvio della sintesi | 50-300 ms | Voci già risolte; sblocco iOS fatto al primo tocco |

I tre tempi vengono misurati a ogni turno e mostrati nella diagnostica. Se Sonnet 5.5 non regge il budget sul dispositivo dell'utente, il passaggio a Haiku 4.5 è un'impostazione.

**Rifiuti e errori.** Sonnet 5.5 può rispondere HTTP 200 con `stop_reason: "refusal"`: l'app lo gestisce (riprova una volta riformulando, poi mostra un messaggio), come gestisce 401 (chiave), 429 (attesa con conto alla rovescia e riprova automatica fino a 3), 5xx, timeout a 20 s e `max_tokens`. La frase dell'utente non va mai persa.

**Costi.** Dalle tariffe ufficiali: Sonnet 5.5 $2 input / $10 output, cache read $0.20 per milione di token. Stima per un turno (≈1.500 token di system prompt in cache, ≈1.000 token non in cache, ≈150 token di risposta): circa $0,004. Una sessione da 10 minuti (≈25 turni) ≈ $0,10; 45 minuti al giorno ≈ $0,45; **circa 10-15 $ al mese con Sonnet, la metà con Haiku**. Il contatore nell'app usa l'`usage` reale restituito dall'API moltiplicato per un listino versionato e modificabile, mai una stima locale dei token.

**Scartato.** Un backend/proxy (non serve: il vincolo è nessun server e il CORS funziona). API vocali "realtime" di altri fornitori (costo, e il cervello dev'essere Claude). JSON chiesto nel prompt senza schema (fragile). Opus 5.5 come predefinito (il thinking sempre attivo costa latenza).

### 1.2 Voce: API del browser, dietro un'interfaccia sostituibile

**Due interfacce, zero dipendenze dal fornitore:**

- `SpeechInput`: `start(lang, profile)`, `stop()`, `abort()`, eventi `interim`, `final`, `end`, `error`, più `capabilities` (continuo sì/no, risultati provvisori, lingua cambiabile a caldo, on-device). Adattatori: `WebSpeechInput` (Web Speech API), `TextInput` (modalità solo testo), in futuro `RecorderInput` (MediaRecorder + riconoscimento cloud, per i casi in cui il browser non ascolta).
- `SpeechOutput`: `speak(segment, { lang, voiceId, rate })` che si risolve a `end` **o** a `error` (perché `cancel()` non produce mai `end`, né in Chrome né in Safari), `cancel()`, `listVoices()`, `capabilities` (eventi boundary, voce selezionabile, serve gesto). Adattatori: `WebSpeechOutput` (speechSynthesis), `TextOutput` (solo testo), in futuro un adattatore cloud con traccia dei tempi per parola `[{charIndex, timeSeconds}]` per la stessa animazione. Ordine consigliato quando servirà: Azure Speech SDK (WebSocket dal browser, eventi `wordBoundary`, voci identiche a quelle di Edge), poi Google Cloud TTS (REST con chiave, CORS verificato, timepoint SSML), poi ElevenLabs, poi OpenAI (nessun timing).

**Due lingue, una voce per lingua.** Ogni segmento della risposta porta la sua lingua; l'app sceglie la voce per lingua e parla segmento per segmento (mai una voce inglese che legge l'italiano). Le voci sono spezzate per frase (≈160-200 caratteri) per evitare i tagli di Chrome sulle frasi lunghe. Cambiare velocità ("più lento") significa `cancel()` e ripetere il pezzo a `rate` 0,8 (pavimento 0,7), tono invariato.

**Voci coerenti con "Vera", in ordine di preferenza (risoluzione automatica per nome e lingua, modificabile):**

| Piattaforma | Inglese (en-GB, poi en-US) | Italiano (it-IT) | Eventi boundary |
|---|---|---|---|
| Edge Windows | Microsoft Sonia Online (Natural), Libby; poi Ava/Emma Multilingual | Microsoft Elsa Online (Natural), Isabella | Probabilmente no → andamento stimato |
| Chrome Windows | Google UK English Female (rete) **oppure** Microsoft Hazel/Susan (locali) | Google italiano **oppure** Microsoft Elsa (locale) | Google: no; locali: sì |
| Chrome/Safari macOS | Serena, Kate, poi Samantha | Federica, Alice | Sì |
| Chrome Android | Solo per lingua: la voce predefinita del motore TTS del telefono (non si sceglie per nome) | idem | No |
| Safari iOS | Solo voci preinstallate; spesso manca una en-GB femminile: Samantha, poi Karen | Alice, se presente | Sì |

Voci infantili (Ana, Maisie), voci "Eloquence" (Eddy, Flo, Grandma…) e voci con nome `undefined` (bug di Edge 150) sono escluse. Nel primo avvio le voci trovate si presentano come "provini": ogni voce con una frase di prova da toccare.

**Eco: half-duplex rigoroso su tutte le piattaforme.** Mentre Vera parla il riconoscimento è fermo (`abort()` prima di `speak()`); si riapre solo da un unico punto ("voce finita") alimentato da `end` o `error` dell'ultima frase o da un watchdog sulla durata stimata, più una coda di sicurezza (120 ms con cavo o altoparlanti, 300 ms se l'uscita sembra Bluetooth). Motivo verificato: la voce sintetica è prodotta dal sistema operativo fuori dalla pipeline audio del browser, quindi la cancellazione d'eco del browser non la "vede" (eccezione: Windows 11 e macOS ≥ 14.2 con `echoCancellation: "all"`).

**Interruzione di Vera (barge-in).** Sempre: un tocco sullo schermo, `Esc` o barra spaziatrice su PC. In più, un rilevatore di energia vocale durante il parlato di Vera, acceso **solo** quando non c'è rischio di auto-interruzione: cuffie rilevate, oppure Chrome/Edge su Windows 11 / macOS 14.2+ con cancellazione d'eco di sistema. Mai su Android e iOS nella v1.

**Reattività alla voce dell'utente.** Su PC: `getUserMedia` + `AnalyserNode` (livello RMS con attacco 40 ms e rilascio 250 ms, rumore di fondo calibrato). Su Android: **nessun secondo flusso microfono** mentre il riconoscitore di Google è attivo (verificato: due catture in conflitto, modalità "chiamata" con volume ridotto); la reattività è guidata dall'arrivo dei risultati provvisori. Su iOS: opzionale, spento di default. La diagnostica dice quale sorgente sta guidando l'animazione.

**Riconoscimento, profili per piattaforma (verificati nel codice dei browser):**

| Piattaforma | Profilo | Fatti da gestire |
|---|---|---|
| Chrome/Edge desktop | `continuous: true`, `interimResults: true`, riavvio in `onend` | Si ferma da solo dopo ≈15 s di silenzio; `no-speech` dopo ≈8 s iniziali; on-device opzionale da Chrome 139 (`processLocally`, pacchetti en-US e it-IT, `install()` da un gesto) |
| Chrome Android | Una frase per `start()`, riavvio in `onend` | Il sistema emette un **bip** a ogni avvio e fine (non disattivabile); pagina nascosta o schermo spento = sessione terminata, va riavviata al ritorno; audio sempre al servizio Google |
| Safari iOS (scheda) | Una frase per sessione, nuovo oggetto a ogni ascolto | Prefisso `webkit`; Siri/Dettatura deve essere attiva; permesso richiesto a ogni caricamento di pagina (quindi mai navigazioni di pagina intera); risultati talvolta ripetuti: dedup per `resultIndex`/`isFinal` |
| iOS app da schermata Home | **Da provare sul dispositivo**: fino al 2024 non funzionava (bug WebKit 225298), due segnalazioni del 2026 dicono che su iOS 26 parte | L'app prova `start()` e, se non arriva `onstart` entro 3 s o arriva `not-allowed`/`service-not-allowed`, passa alla modalità testo con spiegazione |
| Firefox, Chrome su iOS | Non ascoltano (costruttore presente ma non funzionante) | Modalità testo |

Cambio lingua = nuovo oggetto `SpeechRecognition` con la lingua richiesta dalla risposta di Vera (`listen.lang`); mai mutare `lang` su una sessione viva.

**Le frasi di aiuto** ("non ho capito", "ripeti più lento", "come si dice…?") devono funzionare anche quando il riconoscitore è in inglese e sente italiano: un matcher tollerante (distanza di Levenshtein normalizzata su una lista di varianti in entrambe le lingue) intercetta le frasi prima di mandarle al modello; le stesse tre azioni esistono anche come parole toccabili sullo schermo. Il prompt chiede a Vera di interpretare trascrizioni strane come possibile italiano.

**Scartato.** VAD neurale (Silero via onnxruntime: ≈13 MB, fallimenti noti su iPhone). Full-duplex generalizzato. Riconoscimento via registrazione + STT cloud nella v1 (richiede un'altra chiave; l'interfaccia lo prevede per dopo). Il trucco `pause()/resume()` per i tagli di Chrome (rompe Android; lo spezzettamento per frase basta).

### 1.3 Il protocollo del turno (la risposta strutturata)

Ogni risposta di Vera è un oggetto JSON validato da schema. Questo risolve la trappola delle due lingue: ogni pezzo dice in che lingua è, e la risposta dice in che lingua ascoltare dopo.

```jsonc
{
  "segments": [                       // ciò che Vera dice, in ordine; voce scelta per lingua
    { "lang": "it", "text": "Bene. Ora chiedi il conto." },
    { "lang": "en", "text": "Could I have the bill, please?", "kind": "model" }   // "model" = frase da far ripetere
  ],
  "listen": { "lang": "en", "expect": "repeat", "target": "Could I have the bill, please?" },
  "corrections": [                    // massimo 2 per turno
    { "heard": "I have thirty years", "correct": "I am thirty years old",
      "changes": [ { "op": "replace", "from": "have", "to": "am", "index": 1 },
                   { "op": "insert", "to": "old", "index": 4 } ],
      "note_it": "L'età in inglese si dice con to be." }
  ],
  "items": [                          // valutazione degli elementi mirati in questo turno (per la ripetizione spaziata)
    { "kind": "phrase", "id": "p_042", "signal": "PRODUCED" }
  ],
  "learned": [                        // frasi nuove dette correttamente: diventano righe del corpo di Vera
    { "text_en": "Could I have the bill, please?", "gloss_it": "Potrei avere il conto, per favore?", "topic": "ristorante" }
  ],
  "goal": { "id": "g_restaurant_bill", "status": "ongoing" },
  "closing": null                     // a fine sessione: { "remember": ["…", "…", "…"] }
}
```

`listen.lang` imposta la lingua del riconoscitore prima di riaprire il microfono; `expect: "repeat"` attiva il confronto parola per parola con `target`; `segments[].kind = "model"` marca la frase inglese che l'utente deve ridire. I segnali di `items` (`FAILED`, `HARD`, `PRODUCED`, `SPONTANEOUS`, `NOT_OBSERVED`) sono tradotti dall'app in voti FSRS (vedi 1.4). Tutta questa logica (validazione, diff delle correzioni, mappatura dei segnali, aggiornamento della memoria) vive in `src/core/`, senza DOM e senza voce, ed è coperta da test.

### 1.4 Memoria e didattica

**Ripetizione spaziata: FSRS-6** tramite `ts-fsrs` 5.x (MIT, zero dipendenze, ≈60 KB), parametri predefiniti (mediana di 10.000 utenti Anki; sul benchmark pubblico battono anche SM-2 calibrato per utente), `request_retention` 0,9, `maximum_interval` 180 giorni (tutto resta osservabile nei sei mesi). Stesso scheduler per due tipi di elemento: **frasi** (test = produrla quando la situazione la richiede) ed **errori** (test = il prossimo contesto obbligatorio; esempio "I am 30" quando si parla di età). Mappatura dei segnali: `FAILED` e "corretto solo dopo un suggerimento esplicito" → Again; `HARD` (corretto dopo una richiesta di chiarimento) → Hard; `PRODUCED` → Good; `SPONTANEOUS` → Easy (max uno a settimana per elemento); `NOT_OBSERVED` → nessun voto. Regola ferrea (dal manuale Anki): un fallimento al primo tentativo non è mai Hard. Un errore "sparisce" quando è in stato Review, stabilità ≥ 30 giorni, 3 riuscite consecutive e nessuna ricaduta nelle ultime 5 occasioni; resta in sorveglianza passiva e si riattiva se ricompare. Riserva senza dipendenze: scala fissa 1/3/7/14/30 giorni.

**Sessione da 5-10 minuti.** (1) Riscaldamento 1-2 minuti: 2-4 elementi in scadenza, come mini-domande. (2) Scenario 5-6 minuti con un micro-obiettivo concreto ("ordinare la colazione") in 3-4 battute, ciascuna con un criterio di riuscita; Vera parla al massimo due frasi per turno; obiettivo: l'utente parla almeno il 50% del tempo. (3) Chiusura 1-1,5 minuti: "dimmi tre cose che sai dire adesso", prodotte dall'utente (richiamo attivo, ciascuna conta come ripasso), poi l'unico errore da tenere d'occhio. (4) Scrittura dello stato. Massimo 6 elementi mirati per sessione; se il tasso di Again supera il 30% nelle ultime 3 sessioni, nessuna frase nuova finché non scende sotto il 20%.

**Ripresa.** Checkpoint dopo ogni turno (scenario, battuta, ultima frase di Vera, correzione in sospeso). Ripresa entro 2 ore: stessa battuta con un riassunto di una riga; oltre: sessione nuova con riscaldamento e proposta di finire lo scenario.

**La stampella italiana che cala.** Quota di italiano nelle parole di Vera, misurata per sessione e data al modello come obiettivo: A0 (settimane 1-4) ≤ 65%, A1 ≤ 40%, A1+ ≤ 20%, A2 ≤ 12%. Promozione per evidenza, non per calendario: ≥ 80% dei micro-obiettivi del livello completati senza aiuto e Again < 20% negli ultimi 14 giorni. "Non ho capito" ripete la stessa frase inglese più lenta e più corta, poi glossa italiana alla seconda richiesta; "più lento" vale per tutta la sessione; "come si dice X" dà la frase e la fa usare subito, creando una frase con origine `learner_asked`. Le richieste di aiuto non sono mai penalizzate.

**Correzione.** Prima mossa: riformulazione naturale (recast) dentro la risposta; poi una domanda la cui risposta richiede la forma corretta in una frase nuova; se fallisce ancora, un prompt di auto-riparazione; solo alla seconda ricaduta di un errore di regola, un suggerimento di una riga in italiano e la creazione della scheda errore. Massimo 1-2 correzioni per turno, con priorità: errore già in scheda > forma del micro-obiettivo di oggi > errore che compromette la comprensione. Gli errori lessicali non ricevono spiegazioni, solo recast e riuso.

**Progresso senza punteggi.** Il corpo di Vera (vedi 1.7), più: lista "ora so dire" (micro-obiettivi con almeno uno scenario completato senza aiuto), frasi prodotte senza aiuto questa settimana, errori scomparsi, tempo di parola dell'utente in salita, richieste di aiuto in calo, e ogni 4 settimane il rifacimento di uno scenario della prima settimana. Mai mostrati: stabilità FSRS, conteggi di Again, penalità. Se due sessioni di fila vanno male (Again > 35% o parlato < 30%), la successiva è una sessione "facile" (scenario padroneggiato più una frase nuova).

**Pronuncia.** Solo "intelligibilità": sulla frase bersaglio, se il riconoscitore ha sentito le parole giuste (o una delle alternative) in 2 tentativi su 3, è intelligibile; mai un giudizio fonetico dalla trascrizione (la letteratura dice che non è affidabile). Controllo settimanale di coppie minime note per italiani (ship/sheep, h di hotel, th, la vocale finale aggiunta) in cornici neutre.

**Primo avvio.** Vera fa a voce 4-5 domande (viaggi in programma, dove, con chi, interessi, situazioni che preoccupano) e da queste ordina i micro-obiettivi e genera gli scenari. Lista iniziale di micro-obiettivi A1-A2 per i domini di viaggio (aeroporto, hotel, ristorante, indicazioni e trasporti, negozi, imprevisti ed emergenze, chiacchiere) con glossa italiana: 30-40 voci; le formulazioni CEFR vanno verificate prima di pubblicarle (fonti non raggiungibili durante la ricerca).

**Scheda dello studente nel prompt** (≤ 400 token, rigenerata dall'app, non dal modello): livello con evidenza, micro-obiettivo e battute di oggi, elementi in scadenza (≤ 6), errori attivi (≤ 3), preferenze (lento, quota di italiano, nome), riassunto dell'ultima sessione (3 righe), checkpoint se in ripresa, metriche. Le storie complete restano fuori dal prompt.

**Scartato.** SM-2 e Leitner (meno calibrati di una costante sul benchmark; nessun vantaggio didattico). Flashcard esplicite (la ripetizione avviene dentro la conversazione). Strumento memoria lato server (lo stato vive nel browser).

### 1.5 Dati, persistenza, sincronizzazione tra PC e telefono

**Locale.** IndexedDB con un **registro eventi append-only** (`events.jsonl`: ogni evento ha id, timestamp, dispositivo) e uno snapshot derivato; localStorage per preferenze, chiave e calibrazioni. `navigator.storage.persist()` chiesto in modo opportunistico (Chrome lo concede alle PWA installate; Safari solo alle app da schermata Home). Fatto verificato nel codice di WebKit: Safari su iPhone cancella lo storage di un sito dopo 30 "giorni di uso del browser" senza interazione (7 nei casi di tracciamento); le app da schermata Home sono esenti. Quindi: il locale è una cache, la copia remota o l'export è la verità.

**Sincronizzazione predefinita: un repository privato GitHub come archivio dati**, scritto e letto dal browser con la Contents API (CORS verificato con test live il 2 ottobre 2026). Setup una tantum per l'utente (≈5 minuti): creare un repo privato vuoto (per esempio `english-vera-data`), creare un fine-grained personal access token limitato a quel solo repository con permesso `Contents: Read and write` (scadenza fino a 366 giorni o nessuna), incollare il token nell'app su ogni dispositivo (l'app può mostrarlo come QR da PC a telefono). Meccanica: `GET` condizionale con `If-None-Match` (il 304 non consuma quota), unione del registro per id, `PUT` con lo `sha` letto (409/422 se un altro dispositivo ha scritto nel frattempo → rileggi, riunisci, riprova), al massimo un `PUT` ogni 10 secondi, compattazione prima di 700 KB. Raggio d'azione in caso di furto del token: un solo repo privato di dati. Nessun invio dell'header `X-GitHub-Api-Version` dal browser (non è nella lista CORS).

**Sempre disponibile: esporta/importa JSON** ("porta via la stoffa"): Web Share con file su telefono, download su PC, import con unione per id, mai sovrascrittura di progressi più recenti.

**Rinviato.** Cifratura dei dati nel repo (AES-GCM con passphrase): il repo è già privato; da aggiungere se richiesto.

**Scartato e perché.** Gist (verificato: un fine-grained token **può** leggerli, ma i gist "segreti" sono leggibili da chiunque abbia l'URL e la PATCH non ha controllo di concorrenza: due dispositivi si sovrascriverebbero). Google Drive appData (richiede un client OAuth in Google Cloud Console; token da 1 ora senza rinnovo silenzioso nel browser). Dropbox (setup di un'app). WebDAV/Nextcloud (niente CORS di default). File System Access API (solo Chromium).

### 1.6 Pubblicazione e installazione

**GitHub Pages** (repo pubblico: piano gratuito) con GitHub Actions: `actions/configure-pages`, `actions/upload-pages-artifact` (cartella `dist`), `actions/deploy-pages`; Vite con `base: '/english-vera/'`; nessun routing per percorso (niente trucco del 404). **Passo manuale dell'utente:** Settings > Pages > Source = "GitHub Actions" prima del primo deploy.

**PWA** con `vite-plugin-pwa` (Workbox, `registerType: 'autoUpdate'` con controllo orario, precache di app, icone e font), manifest con `id`, icone 192/512 e maskable, `apple-touch-icon`, meta per iOS. Android: pulsante "Installa" proprio via `beforeinstallprompt`. iOS: istruzione "Condividi > Aggiungi alla schermata Home" (non esiste un'API). Durante la sessione: `navigator.wakeLock` chiesto nel tocco di avvio (su iOS funziona nelle app da schermata Home solo da iOS 18.4) e riacquisito su `visibilitychange`.

**Onestà sulla modalità "telefono in tasca".** Con lo schermo spento il riconoscimento muore su Android e su iOS: nessuna app web può prometterlo. Il wake lock tiene lo schermo acceso; l'app lo dice al primo avvio ("in tasca lo schermo resta acceso, con la luminosità al minimo") e, se il sistema spegne lo schermo, al ritorno dice "Mi ero fermata: lo schermo si è spento" e riprende dall'ultima frase con un tocco. Il tasto delle cuffie (Media Session con un audio silenzioso in loop > 5 s) è una funzione sperimentale, spenta di default.

**Font.** Self-hosted via `@fontsource-variable` (licenza OFL, file di licenza nel repo), sottoinsieme latino, precache; `font-display: block` con fallback a metriche compatibili (`size-adjust`) per evitare salti.

### 1.7 Identità visiva: "Vera al telaio"

Quattro concept sono stati sviluppati in parallelo (l'organismo tipografico del tuo seed, "Corpus"; un tabellone a palette di stazione, "Partenze"; una pagina composta a mano, "La Forma"; e il telaio, "Trama") e giudicati da tre lenti (direzione creativa, ingegnere front-end, l'utente). Punteggi: Trama 136, Corpus 132, Partenze 131, La Forma 112. I testi integrali e i giudizi sono in `docs/ricerca/`. **Proposta: il telaio, con innesti da Corpus e Partenze.** È l'unico concept in cui ogni stato è un gesto meccanico riconoscibile anche da fermo, il più economico da far girare a 60 fps su un telefono di fascia media, e quello in cui il passaggio dall'italiano all'inglese ha una forma strutturale. Rispetto al seed: il corpo resta "fatto delle frasi imparate", ma ordinate come una stoffa che si allunga e si infittisce invece di una colonna, così la crescita si legge come lunghezza e densità, non come "più roba".

**L'idea.** L'ordito verticale è il tuo italiano, teso prima che tu cominci. La trama orizzontale sono le frasi inglesi che **tu** dici correttamente: una riga per frase, battuta dal pettine. Le parole di Vera non diventano stoffa: la sua riformulazione è un filo guida alla linea di battuta e diventa tessuto solo quando la dici tu. La stoffa è ciò che sai dire, non ciò che hai sentito.

**Anatomia (niente telaio di legno disegnato, solo le parti che lavorano).** Dall'alto: il **pettine**, una barra di dentini verticali che porta l'etichetta di stato, grande (≥ 20 px su telefono: i tre giudici hanno bocciato all'unanimità le etichette da 11 px); la **linea di battuta**, dove nasce ogni riga nuova e dove sta, in grande, quello che dici; la **stoffa**, che cresce verso il basso e si scorre; la **cimosa** a sinistra, con un nodo per ogni sessione (niente numeri, niente fiammelle); il **rotolo** in fondo, che si ispessisce con la stoffa arrotolata. L'ordito corre attraverso tutto, ma **sopra il testo solo nei margini** (l'intreccio sopra le lettere a 15 px era la bandiera rossa comune: va prototipato per primo e, se disturba, resta fuori dal testo).

**Crescita.** Giorno 0: solo l'ordito e una riga fantasma: "La prima riga la tessi tu." Dopo la prima sessione: 6-10 righe sottili. Un mese: una sciarpa, le prime righe a peso pieno. Sei mesi: una stoffa lunga, scura, quasi solo inglese. Il peso del carattere di ogni riga è il numero di volte che l'hai detta bene in sessioni diverse (300 → 500 → 700); una frase non detta da 30 giorni perde un grado. L'opacità dell'ordito è la quota di italiano nelle parole di Vera negli ultimi turni: l'impalcatura si ritira dietro la stoffa man mano che Vera ti parla in inglese. Toccando una riga, sotto compare la traduzione italiana (l'italiano sta letteralmente sotto l'inglese) con "ascolta" e "ritessi". Innesto da Corpus: il **ritratto**, una miniatura della stoffa (20×96 px su telefono accanto al nome) in cui ogni riga è un tratto lungo quanto la frase e scuro quanto il suo peso: il progresso a colpo d'occhio e l'immagine da condividere.

**Stati, nettamente diversi anche con "riduci animazioni":**

| Stato | Geometria | Etichetta | Con movimento | Con movimento ridotto |
|---|---|---|---|---|
| Ascolta | L'ordito si apre in un varco a losanga alla linea di battuta; il trascritto grande entra nel varco | ASCOLTO | I fili vibrano con la tua voce (0-4 px); il varco si chiude lentamente (320 ms) dopo il silenzio: vedi che "ho finito" è stato capito e puoi riprendere | Varco aperto statico; il filo sotto la parola corrente cambia spessore a scatti (1/2/3 px, max 4 volte al secondo) |
| Pensa | Varco chiuso, pettine alzato, filo guida tratteggiato che misura la riga avanti e indietro | VERA PENSA | Il filo guida viaggia (1,2 s per attraversata); oltre 6 s compare "ci sto mettendo più del solito" | Filo tratteggiato statico; oltre 4 s un secondo tratteggio |
| Parla | Pettine abbassato che batte; la riga di Vera, in indaco, appare **prima intera a bassa opacità** (innesto da La Forma) e si "inchiostra" parola per parola | VERA PARLA | Navetta che precede la parola corrente; battuta di 3 px per parola, 4 px sulle sillabe toniche inglesi (il ritmo dell'inglese reso visibile) | Parole che si scuriscono una per una, senza spostamenti |
| Corregge | Sulla tua riga grande la parola sbagliata diventa un nodo e si trasforma in quella giusta, in robbia; poi la riga corretta sale e diventa fantasma a contrasto pieno con contorno tratteggiato, sotto la didascalia "Ora dilla tu" | RIPETI | Se le due parole condividono ≥ 40% delle lettere, morfosi lettera per lettera (innesto da Corpus: "peoples" → "people" toglie solo la s, sotto 1 s); altrimenti disfatta e ritessitura; durante la ripetizione le parole del fantasma si riempiono quando combaciano, allineate in colonna con quelle che dici (innesto da Partenze) | Parola sbagliata barrata e parola giusta impilata sopra, in robbia; poi riga ridisegnata |
| Riposo | Nessuna riga aperta, navetta agganciata in verticale, la stoffa è il contenuto | — | Nessuna "luce da finestra" (tolta: era un gradiente e un cliché da app di meditazione) | Statico |

Regola di colore innestata da Corpus: **il colore di correzione compare solo quando sbagli e sparisce quando ripeti bene**; una sessione senza errori non contiene mai rosso. Gli errori di sistema (chiave, rete, microfono, budget) non usano mai il colore di correzione, così "hai speso troppo" non si confonde con "hai sbagliato".

**Tipografia.** Due lingue, due voci: **inglese = sans dritto, italiano = serif corsivo**, mai confondibili, la lingua si riconosce dal carattere e non dal colore. Inglese e interfaccia: Bricolage Grotesque (variabile: peso, dimensione ottica, larghezza; stretta a 15 px nelle righe della stoffa, rilassata a 34-56 px nel trascritto; il peso è il grado di consolidamento). Italiano: Newsreader corsivo (variabile con dimensione ottica; scelto al posto di Fraunces perché la combinazione Fraunces + carta avorio è diventata il template del 2025-26, come ha notato la lente di direzione creativa). Regole: l'italiano non è mai in grassetto, l'inglese mai in corsivo; niente Inter, Roboto, Arial, niente monospace. Scale: trascritto 34 px telefono / 56 px desktop; righe della stoffa 15-16 px; etichetta di stato 20 px; cifre tabellari per i costi. Sottoinsiemi latini, preload, `size-adjust` sui fallback; compensazione di peso in tema scuro.

**Colore.** Lino e tinte da tintoria naturale, opache, niente gradienti, vetro, blur o viola. Chiaro "lino": sfondo `#F2EEE6`, inchiostro `#2A2622`, Vera indaco matto `#2E3A66`, correzione robbia `#B0303A`, parola sbagliata grigio-fibra `#9B8B7A`, ordito `#B3935F` che sbiadisce. Scuro "lana di notte": sfondo `#171513`, inchiostro `#EDE6D8`, Vera `#A9B8E6`, correzione `#E2645A`, ordito `#6E5A3C` con pavimento al 12% di opacità. Tinte per argomento ridotte a **tre** (viaggio e trasporti, tavola e alloggio, città e imprevisti) più il neutro per le chiacchiere, ognuna in due valori (filo e inchiostro ≥ 4,5:1). Token su `:root`, tema scuro sotto `prefers-color-scheme` e `[data-theme]`. Prova brutale prima di procedere: uno screenshot senza il corpo deve ancora essere Vera, altrimenti l'identità è presa in prestito dai font.

**Movimento.** Due curve soltanto (assestamento smorzato per pettine e varco; navetta lineare con frenata finale). Tutto ciò che si muove è `transform`/`opacity`; un solo Canvas 2D per l'ordito nella zona di battuta, `requestAnimationFrame` attivo solo in Ascolta e Pensa; stoffa in DOM statico con `content-visibility` e virtualizzazione oltre 300 righe; span per lettera solo per le due parole in correzione. Innesto da Partenze: misurazione del tempo di frame nei primi 3 s di sessione e, sopra 20 ms medi, passaggio automatico alla coreografia ridotta. `prefers-reduced-motion` e interruttore manuale rispettati come da tabella.

**Animazione "mentre parla" senza l'audio.** Driver primario: `onboundary` (parola). Driver di riserva sempre pronto: un orologio stimato (90 ms + 70 ms per sillaba in inglese, 80 + 60 in italiano, diviso per `rate`, più pause di punteggiatura) che parte a `onstart`, si riallinea a ogni boundary reale e si chiude a `onend`; un fattore di calibrazione per voce (media mobile esponenziale in localStorage) riduce l'errore sotto il 10% dopo 2-3 frasi. Nelle prime due frasi per voce l'ingresso è a gruppi di parole, più discreto. La diagnostica dice "boundary: sì / no / stimati · calibrazione 0,94".

**Stati vuoti e di errore, disegnati.** Primo avvio: ordito teso, due capi di filo da annodare ("Chiave" e "Voce", quest'ultima come provini), poi la riga fantasma. Microfono negato: fili annodati alla linea di battuta, pettine "MICROFONO CHIUSO", passi esatti per browser, "Riprova", e **"Oppure scrivi"** sempre disponibile (innesto da La Forma). Offline: l'ordito perde tensione (catenarie), "SENZA RETE", modalità ripasso (tocchi le righe, Vera le dice con le voci locali, tu ripeti). Errore API: il filo guida si spezza, "FILO SPEZZATO", causa in italiano in una riga, conto alla rovescia sul 429, "Riannoda"; la tua frase resta nel varco. Browser che non ascolta: "Qui posso parlare ma non ascoltarti" più la modalità a tastiera. Chiave invalida: convalida immediata con motivo in italiano (innesto da Partenze).

**Impostazioni, costo e diagnostica = l'"etichetta di composizione"** cucita nella cimosa: superficie di lino, bordo a punto di cucitura, titoli in corsivo. Sezioni: voce (provini, velocità), lingua (cursore italiano ↔ inglese, con l'ordito che sbiadisce in anteprima), microfono (prova), chiave, modello e listino, tema, movimento, dati (esporta/importa/sincronizza), costo (oggi · sessione · totale, "ogni riga tessuta costa in media €0,003", budget giornaliero con filo che diventa inchiostro con filetto, non rosso, sopra budget), e **composizione**: la diagnostica copiabile. Contenuto: versione e hash di build; browser, sistema, modalità (scheda / app installata); lingua in ascolto e profilo del riconoscitore; voci disponibili e scelte (locale/rete); microfono (permesso, livello, rumore di fondo, sorgente della reattività); cancellazione d'eco in uso; rete; modello e listino; tempi dell'ultimo turno (fine parlato → prima parola → inizio voce); boundary sì/no/stimati e calibrazione; ultimi errori con codice e ora; righe e sessioni totali; spazio usato; stato della sincronizzazione; wake lock e Media Session. Un bottone "Copia etichetta" produce testo semplice a due colonne con puntini di guida (innesto da Partenze), incollabile in una mail; "mostra grezzo" rivela lo stesso JSON, sulla stessa carta: mai una console nera.

**Modalità tasca.** Dopo 20 s senza tocchi o con una voce esplicita nelle impostazioni: layout a contrasto massimo e luminosità minima con la sola etichetta di stato a 40 px e il trascritto a 24 px; tocchi ignorati tranne la pressione lunga; earcon per stato (pizzico di filo all'apertura del varco, doppio pizzico alla correzione, generati con Web Audio); Vera dice sempre tutto a voce, comprese le correzioni ("non goed: went"), con l'opzione "ripete le correzioni due volte". Entrata e uscita sono esplicite e dette a voce, niente gesti nascosti.

---

## 2. Dove funziona bene e dove ha limiti

| | PC Chrome/Edge (Windows, macOS) | Android, Chrome (anche installata) | iPhone, Safari |
|---|---|---|---|
| Ascolto | **Ottimo.** Continuo, con risultati provvisori; riavvio automatico; on-device opzionale su Chrome 139+ | **Buono.** Una frase per volta con **bip di sistema** a ogni avvio e fine (non disattivabile); audio al servizio Google; schermo acceso obbligatorio | **Scheda Safari: accettabile** (una frase per volta, Siri attiva, permesso a ogni apertura). **App da schermata Home: da verificare sul tuo iPhone**; se non ascolta, modalità testo |
| Voce di Vera | **Ottima** su Edge (voci "Natural" Sonia + Elsa); buona su Chrome (voci Google o di sistema) | **Dipende dal telefono**: voce predefinita del motore TTS per lingua, non scelta per nome | **Limitata**: solo voci preinstallate, forse nessuna inglese britannica femminile; primo tocco obbligatorio |
| Animazione "mentre parla" | Sincronizzata (voci locali) o stimata (voci in rete) | Stimata | Sincronizzata |
| Interruzione di Vera a voce | Sì con cuffie, o su Windows 11 / macOS 14.2+ | Solo con un tocco | Solo con un tocco |
| Reattività alla tua voce | In tempo reale (Web Audio) | Dai risultati provvisori del riconoscitore | Opzionale |
| Telefono in tasca | — | Con schermo acceso (wake lock); muore se lo schermo si spegne | Con schermo acceso solo da iOS 18.4 nell'app installata; muore con lo schermo spento |
| Installazione | Icona nella barra dell'indirizzo | Prompt di installazione, icona, vibrazione, tasto cuffie | Condividi > Aggiungi alla schermata Home; niente vibrazione |
| Dati | Durevoli; sync via repo | Durevoli; sync via repo | Safari cancella lo storage dopo 30 giorni senza uso: la sync o l'export sono necessari; l'app installata è esente |
| Verdetto | Prima classe | Buona, con il bip | Scheda: sufficiente. App: da provare. Alternativa futura: registrazione + riconoscimento cloud (altra chiave) |

Firefox e Chrome su iPhone: Vera parla ma non ascolta; modalità testo.

---

## 3. Architettura del codice

**Stack.** Vite 8 + TypeScript 7 strict, senza framework UI (una macchina a stati esplicita scrive `data-state` sulla radice e il CSS ne deriva; moduli con funzioni di rendering DOM; Preact resta un'opzione per i pannelli se la verbosità lo giustifica). Vitest 5 per il core e per i parser; Playwright 1.63 con il Chromium headless della macchina per prove d'interfaccia e screenshot (riconoscitore e sintesi finti iniettati con `addInitScript`, API Claude intercettata con `page.route`). `vite-plugin-pwa` 1.3. `@anthropic-ai/sdk` 0.131. `ts-fsrs` 5.x. Nessun'altra dipendenza di runtime.

**Separazione netta: la logica non sa nulla di voce e DOM.**

```
src/
  core/        logica pura, testata a fondo
    turn/      schema della risposta (JSON schema + tipi), estrattore JSON incrementale, validazione, diff delle correzioni
    session/   macchina a stati (riposo, ascolta, pensa, parla, corregge, ripeti, errore), regole di sessione e ripresa, rilevatore delle frasi di aiuto
    memory/    profilo, frasi, errori, scenari, sessioni; registro eventi + riduttori; unione per id
    srs/       scheduler FSRS, mappatura segnali → voti, regole di ritiro
    prompt/    system prompt, scheda dello studente, micro-obiettivi iniziali
    cost/      token × listino versionato, budget
    pacing/    orologio stimato per l'animazione del parlato, calibrazione
  llm/         client Claude (SDK, streaming, usage, errori, rifiuti); client finto per test
  voice/       interfacce SpeechInput/SpeechOutput; adattatori Web Speech (profili per piattaforma, risoluzione voci, chunking, half-duplex); adattatori testo; rilevatore di energia (desktop)
  storage/     IndexedDB, localStorage, export/import, adattatore di sync (GitHub Contents API)
  ui/          telaio (ordito, pettine, linea di battuta, stoffa, cimosa, rotolo), trascritto, correzione, etichetta di composizione, stati vuoti/errore, modalità tasca, earcon
  platform/    rilevamento capacità (standalone, wake lock, Media Session, vibrazione, AEC di sistema), PWA
tests/         unit (Vitest) e e2e (Playwright)
docs/          PIANO.md, ricerca/, DECISIONI (nel CLAUDE.md)
.github/workflows/  build + typecheck + test + deploy su Pages
```

**Modalità solo testo** come cittadino di prima classe: stessa macchina a stati, `TextInput`/`TextOutput`; serve all'utente quando non può parlare e a me per provare tutto senza audio.

**Qualità prima di ogni consegna.** `npm run check` = typecheck + lint + test + build; Playwright esegue un giro completo in modalità testo con API finta e salva screenshot degli stati principali e dei temi (chiaro, scuro, movimento ridotto), che vengono guardati. Niente si pubblica rosso.

---

## 4. Traguardi, in ordine

1. **Un giro completo.** Scaffolding, CI, deploy su Pages, CLAUDE.md. Impostazioni con chiave (salvata in locale, convalidata subito) e scelta voci. Tocco → ascolto → risposta strutturata in streaming → voce bilingue segmento per segmento → riapertura del microfono. Telaio v1: ordito, pettine con etichetta grande, varco, trascritto grande, riga di Vera, stati Ascolta/Pensa/Parla/Riposo, tema chiaro e scuro, movimento ridotto. Modalità solo testo. Etichetta di composizione con diagnostica copiabile e contatore di costo da `usage`. Test del core e screenshot. **Risultato: apri la pagina, parli, ti capisce, ti risponde a voce nelle due lingue.**
2. **Memoria e sessioni.** Primo avvio con le domande a voce; profilo; micro-obiettivi e scenari; sessione in tre fasi con chiusura "tre cose"; checkpoint e ripresa; la stoffa che cresce e si salva (IndexedDB); cimosa; ritratto; export/import.
3. **Correzioni e ripetizione.** Correzioni strutturate → trasformazione della parola sotto gli occhi, riga fantasma, confronto in colonna; FSRS per frasi ed errori; segnali → voti; riscaldamento con gli elementi in scadenza; errori che spariscono; regola di fading dell'italiano; frasi di aiuto in entrambe le lingue.
4. **Telefono.** PWA installabile, wake lock, profili Android e iOS, probe dell'ascolto in app installata, modalità tasca con earcon, "Oppure scrivi", sync con repo privato, stati offline.
5. **Rifinitura.** Interruzione a voce dove sicura, on-device su Chrome desktop, misurazione del frame time con coreografia ridotta automatica, Media Session sperimentale, specimen delle voci, prove su dispositivi reali con la diagnostica incollata, e (se richiesto) adattatore TTS cloud e riconoscimento via registrazione per iPhone.

Ogni traguardo finisce con build, tipi e test verdi, screenshot guardati, CLAUDE.md aggiornato e una nota su cosa funziona, cosa non ho potuto verificare e cosa resta da fare a mano.

---

## 5. Passi che restano all'utente

- Attivare GitHub Pages: Settings > Pages > Build and deployment > Source = **GitHub Actions** (una volta sola, prima del primo deploy).
- Creare una chiave API nella Console Anthropic (meglio dedicata e con scadenza) e, consigliato, un limite di spesa mensile in Settings > Billing.
- Per la sincronizzazione (traguardo 4): creare un repository privato vuoto per i dati e un fine-grained token limitato a quel repo con `Contents: Read and write`.
- Provare sui propri dispositivi e incollare l'etichetta diagnostica quando qualcosa non va: io non sento l'audio.
- Su iPhone: Siri/Dettatura attiva; iOS 18.4 o successivo per lo schermo acceso nell'app installata.

---

## 6. Domande aperte

1. **Telefono: iPhone o Android?** Cambia quanto lavoro va nel percorso iOS (probe dell'ascolto nell'app installata, voci limitate) e cosa posso promettere.
2. **Identità visiva:** va bene il telaio con gli innesti, oppure preferisci "Corpus" (il più vicino al tuo seed, ma con stati meno leggibili su telefono e un rendering su Canvas più rischioso)?
3. **Sincronizzazione:** d'accordo con il repo privato più token (5 minuti di setup), o per ora basta esporta/importa? Riguarda solo il traguardo 4.

Se non ci sono obiezioni, le ipotesi di lavoro sono: Sonnet 5.5 come modello predefinito, telaio come identità, repo privato per la sync.
