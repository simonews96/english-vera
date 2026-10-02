# Vera — piano di progetto

Versione 2, 2 ottobre 2026. **Stato: in attesa dell'approvazione dell'utente. Nessun codice applicativo è stato scritto.**

Vera è un tutor vocale di inglese personale: un'app statica su GitHub Pages, installabile sul telefono, che ascolta, risponde a voce in italiano e in inglese, corregge, ricorda e fa progredire un principiante assoluto italiano verso un inglese da viaggio in sei mesi, in sessioni da 5-10 minuti.

Le decisioni poggiano su una ricerca fatta il 2 ottobre 2026 su fonti primarie (documentazione Anthropic, codice sorgente di Chromium e WebKit, documentazione GitHub e Apple) con verifica avversariale delle affermazioni critiche, e su una critica avversariale di questo stesso piano (quattro lenti: voce e browser, API e sicurezza, prodotto e didattica, completezza). Gli appunti, con fonti e livelli di confidenza, sono in `docs/ricerca/`. Dove un fatto è solo probabile o non verificato lo dico.

---

## 1. Decisioni chiave

### 1.1 Cervello: API di Claude chiamata dal browser

**Funziona, verificato con test live il 2 ottobre 2026.** `api.anthropic.com` risponde con `Access-Control-Allow-Origin: *` quando la richiesta porta l'header `anthropic-dangerous-direct-browser-access: true`. L'SDK ufficiale TypeScript (`@anthropic-ai/sdk` 0.131, ESM, compatibile con Vite) lo aggiunge con `dangerouslyAllowBrowser: true`. È una funzione dichiarata nelle release notes Anthropic del 22 agosto 2024 e nella pagina dell'SDK TypeScript, stabile da due anni. Eccezione: organizzazioni con accordo Zero Data Retention (non un account personale) ricevono 401 con il testo "CORS requests are not allowed for this Organization"; l'app riconosce il messaggio e lo spiega.

**Dove stanno i segreti e cosa comporta.** La chiave Anthropic (e, dal traguardo 4, il token GitHub per la sincronizzazione) vive solo nel browser del dispositivo, mai nel repository, mai in URL, mai nei log, mai nei file esportati o sincronizzati (test unitario). **Rischio da sapere:** su GitHub Pages tutti i siti dello stesso account condividono l'origine `simonews96.github.io` (il repo è solo un percorso), quindi qualunque altra pagina pubblicata su quell'account potrebbe leggere i segreti di Vera. Contromisure: non pubblicare altri siti Pages su quell'account (o usare un dominio personalizzato), una Content Security Policy severa nella pagina (vedi 1.6), nessuno script di terze parti, un bottone "Dimentica chiave/token su questo dispositivo", e l'avviso scritto accanto al campo della chiave al primo avvio. Consiglio: creare nella Console Anthropic una chiave dedicata con scadenza e un limite di spesa mensile in Settings > Billing. La convalida della chiave usa `GET /v1/models` (non consuma token): 200 = valida; 401 con testo ZDR = serve un proxy, non praticabile; 401 generico = chiave errata. La stessa chiamata popola il menu dei modelli.

**Modello predefinito: `claude-sonnet-5-5`.** Ogni modello ha la sua configurazione, perché i parametri non sono intercambiabili (verificato: `between_tools` è accettato solo da Sonnet 5.5; Haiku 4.5 rifiuta `adaptive` ed `effort`; Opus 5.5 rifiuta `disabled` e `between_tools`):

| Preset | Configurazione | Perché | Note |
|---|---|---|---|
| **Sonnet 5.5** (predefinito) | `thinking: { type: "between_tools" }`, `output_config.effort: "low"` fisso per tutta la sessione | Senza strumenti dichiarati significa "nessun ragionamento prima della risposta": prima parola più rapida; $2 / $10 per milione di token | `effort` non può cambiare a metà conversazione con `between_tools` (400) e cambiarlo invalida la cache; mai `temperature`, prefill o `tool_choice` forzato (400) |
| Sonnet 5.5 "adaptive low" | `thinking: { type: "adaptive", display: "omitted" }`, `effort: "low"` | La guida ufficiale consiglia `adaptive` per compiti JSON/ragionamento; a `low` salta il thinking sulle richieste semplici | Da confrontare con il preset predefinito nel traguardo 1 (tempo alla prima parola e qualità delle correzioni su 20 turni) |
| Haiku 4.5 ("turbo") | nessun campo `thinking`, nessun `effort` | Il più veloce; $1 / $5 | Insegnante più debole; il suo prompt non va in cache sotto 4.096 token; data minima di ritiro "non prima del 15 ottobre 2026", nessun ritiro annunciato: ricontrollare |
| Opus 5.5 ("qualità") | `thinking` omesso, `effort: "low"` | Qualità massima; $4 / $20 | Il thinking non si può spegnere: prima parola più lenta |
| Altro ID | nessun `thinking`, nessun `effort`, nessun `temperature` | Permette un modello futuro senza nuovo deploy | Con override avanzato "ragionamento: auto / nessuno / between_tools" e messaggio chiaro se il server risponde 400 sul parametro |

**Risposta strutturata in streaming.** Gli structured outputs sono GA (`output_config.format` con JSON schema, nessun header beta) e arrivano come testo in streaming. L'app accumula il JSON e, con un estrattore incrementale, fa partire la voce al primo segmento chiuso. Regole dello schema: `additionalProperties: false` ovunque, niente `minLength`/`pattern`, nessun campo chiamato `reasoning` o `thinking` (rifiuto per `reasoning_extraction`), `segments` come prima proprietà richiesta, enum normalizzati in maiuscolo dall'app (la capitalizzazione non è garantita), una sola versione di schema per traguardo (cambiarlo invalida la cache e ricompila la grammatica). Al primo uso di uno schema c'è una latenza di compilazione (cache 24 ore): l'app fa una richiesta di riscaldamento minima all'avvio e dopo più di 20 ore di inattività. `max_tokens` esplicito ≈ 1.536 (il tokenizer di Sonnet 5.5 produce ≈30% di token in più di Haiku).

**Prompt caching, disegnato per andare in cache davvero.** Il system prompt è in due blocchi: il primo, **stabile** (ruolo, regole didattiche, protocollo), porta `cache_control: { type: "ephemeral" }` e supera i 512 token minimi di Sonnet; la **scheda dello studente**, che cambia a ogni turno, sta **dopo** il breakpoint, come primo messaggio utente della sessione. Dentro una sessione la storia è **append-only** (mai finestra scorrevole: 25 turni ≈ 6-8k token stanno benissimo) e il `cache_control` automatico a livello di richiesta fa leggere la storia dalla cache a $0,20 per milione; nei turni assistente della storia si salva solo il testo dei `segments`, non il JSON intero. La configurazione di thinking ed effort resta costante per tutta la sessione.

**Latenza: obiettivo misurabile, non promessa cieca.** Dalla fine del parlato all'inizio della voce di Vera:

| Tratto | PC Chrome/Edge | Android Chrome | iPhone Safari |
|---|---|---|---|
| Fine frase riconosciuta | 600-900 ms (soglia di silenzio nostra, 1,2 s nel rilevatore locale, con chiusura anticipata al risultato finale) | **Decide il servizio Google**: pausa "di qualche secondo", riportati ≈3-5 s, non controllabile | Decide il framework Apple; timer nostro di 750 ms senza nuovi risultati provvisori |
| Prima parola del modello | 500-1.200 ms stimati (nessun dato ufficiale: si misura nel traguardo 1) | idem, più rete mobile | idem |
| Primo segmento JSON chiuso | 100-300 ms (segmento breve per contratto di prompt) | idem | idem |
| Avvio della sintesi | 50-300 ms (voci già risolte e sbloccate) | 100-400 ms (motore di sistema) | 50-300 ms |
| **Totale atteso** | **mediana ≈ 1,5-2 s, obiettivo ≤ 2 s** | **≈ 2-5 s, dipende dal sistema** | **≈ 1,5-3 s** |

Contromisure: `<link rel="preconnect">` verso `api.anthropic.com`; preflight CORS valido 10 minuti (`max-age: 600`); riscaldamento dello schema; storia in cache; contesto piccolo; primo segmento corto; confronto Sonnet `between_tools` contro `adaptive low` contro Haiku nel traguardo 1, con scelta del predefinito dopo la misura. I tre tempi (fine parlato → prima parola → inizio voce) sono misurati a ogni turno, mostrati nell'etichetta di composizione e riportati nella tabella della sezione 2.

**Errori, uno per uno:**

| Caso | Comportamento | Messaggio (italiano, in una riga) |
|---|---|---|
| 401 generico | nessun retry | "Chiave non valida: controlla l'etichetta" |
| 401 "CORS requests are not allowed for this Organization" | nessun retry | "La tua organizzazione Anthropic non permette chiamate dal browser (ZDR)" |
| 400 "You have reached your specified API usage limits" / 429 `enforced_spend_limit_reached` senza `retry-after` | nessun retry | "Hai raggiunto il limite di spesa impostato in Settings > Billing" |
| 429 con `retry-after` | attesa pari a `retry-after`, max 3, con conto alla rovescia | "Troppe richieste, riprovo tra 8 s" |
| 529 / `overloaded_error` nello stream | 1 retry | "Il servizio è sovraccarico, riprovo" |
| 5xx, errore di rete | 1 retry con backoff | "Il servizio non risponde" |
| timeout: 20 s agli header, poi watchdog "nessun delta da 8 s" | chiude lo stream | "Filo spezzato: nessuna risposta" |
| `stop_reason: "refusal"` | un solo nuovo invio dello stesso contesto a `claude-haiku-4-5` (nessun classificatore elencato); se rifiuta ancora, messaggio | "Vera non può rispondere a questo: proviamo un'altra frase" |
| `max_tokens` | risposta troncata: trattata come errore | "Risposta interrotta, riprovo" |

Il client SDK gira con `maxRetries: 0` e la politica sopra (altrimenti i retry interni si sommano ai nostri e il conto alla rovescia mente). Su `refusal` e `max_tokens` il JSON parziale **non viene mai validato né scritto nel registro eventi**: quanto Vera ha già detto a voce resta, lo stato no. La frase dell'utente non va mai persa: "Riannoda" la rimanda. Il barge-in non interrompe mai la richiesta HTTP (le risposte sono brevi: si ferma solo la voce), così l'`usage` finale arriva sempre; se una richiesta viene comunque abortita, si conta l'ultimo `message_delta.usage` ricevuto e il turno è marcato "stima parziale".

**Costi, rifatti con numeri realistici.** Tariffe ufficiali Sonnet 5.5: $2 input, $10 output, cache read $0,20, cache write $2,50 (TTL 5 minuti) per milione di token. Turno tipico con il caching sopra: ≈1.500 token di system prompt in cache + ≈3.000 di storia in cache + ≈600 nuovi (scheda e ultimo turno) + ≈300 di output JSON ≈ $0,005; i primi turni di ogni sessione costano di più per la scrittura in cache. Sessione da 10 minuti (≈25 turni) ≈ $0,15; 45 minuti al giorno ≈ $0,6-0,8; **≈ 15-25 $ al mese con Sonnet 5.5; con Haiku circa un quarto in meno** (il suo prompt non va in cache sotto 4.096 token), non la metà. Il contatore usa l'`usage` reale restituito dall'API (compresi i token di scrittura cache) moltiplicato per un listino versionato, con data e etichetta "stima" visibili; la spesa è mostrata in dollari, con un cambio in euro facoltativo impostato dall'utente; budget giornaliero predefinito $0,80.

**Scartato.** Un backend/proxy (non serve: nessun server per vincolo, il CORS funziona). API vocali "realtime" di altri fornitori (costo, e il cervello dev'essere Claude). JSON chiesto nel prompt senza schema (fragile). Opus 5.5 come predefinito (thinking non spegnibile). Riprovare un rifiuto "riformulando" (l'app non può riformulare ciò che l'utente ha detto e lo stesso contenuto riceve lo stesso rifiuto).

### 1.2 Voce: API del browser, dietro un'interfaccia sostituibile

**Due interfacce, zero dipendenze dal fornitore.**

- `SpeechInput`: `start(lang, profile)`, `stop()`, `abort()`, eventi `interim`, `final`, `start`, `end(cause)`, `error(code)`, più `capabilities` (continuo, risultati provvisori, on-device). Adattatori: `WebSpeechInput` (Web Speech API, con i profili per piattaforma), `TextInput` (solo testo), in futuro `RecorderInput` (MediaRecorder + riconoscimento cloud con una chiave dell'utente, per i casi in cui il browser non ascolta).
- `SpeechOutput`: `speak(segment, { lang, voiceId, rate })` → `Promise<"ended" | "cancelled" | "error">`, `cancel()`, `listVoices()`, `capabilities` (eventi boundary, voce selezionabile, serve gesto). Adattatori: `WebSpeechOutput` (speechSynthesis), `TextOutput`, in futuro un adattatore cloud con traccia dei tempi per parola `[{charIndex, timeSeconds}]` per la stessa animazione. Ordine consigliato quando servirà: Azure Speech SDK (WebSocket dal browser, eventi `wordBoundary`, voci identiche a quelle di Edge), poi Google Cloud TTS (REST con chiave, CORS verificato, timepoint SSML), poi ElevenLabs, poi OpenAI (nessun timing).

**Il contratto di `speak()`, scritto sui fatti verificati nel codice dei browser.** `cancel()` non produce mai `end`; su Chrome/Edge/Android dà `error("interrupted")` **solo** all'utterance in corso e **nessun evento** a quelle accodate dalla pagina; su Safari dà `error("canceled")` a tutte, ma fino a Safari 27 uno `speak()` chiamato subito dopo `cancel()` può ricevere un `end` spurio o venire scartato. Quindi: l'adattatore tiene **una sola utterance nel browser alla volta** (il segmento successivo parte dall'`end`/`error` del precedente); ogni `cancel()` porta un token di generazione che risolve a `"cancelled"` tutte le promesse in volo senza aspettare eventi; ogni utterance ha un watchdog (durata stimata + 1,5 s) e un riferimento tenuto vivo fino alla fine (bug di garbage collection di Chrome che fa sparire `end`); su WebKit lo `speak()` successivo a un `cancel()` è rinviato a un macrotask e un `end` arrivato prima di `start` è ignorato. Il punto unico "voce finita" che riapre il microfono è alimentato da questa promessa, mai da un evento nudo.

**Caricamento delle voci: asincrono su tutte le piattaforme** (Chrome/Edge: primo `getVoices()` vuoto e `voiceschanged` sottoscritto solo dopo una chiamata a `getVoices()`; Edge aggiunge le voci "Natural" in un evento successivo; Android: lista vuota finché il motore non è inizializzato; Safari su OS ≥ 26.3: lista vuota al primo giro). Procedura: `getVoices()` subito; se vuoto, attesa di `voiceschanged` con timeout di 2 s e rilettura; risoluzione rieseguita a ogni evento successivo; `voiceURI` scelto per lingua salvato in locale e riconvalidato al caricamento; nei provini del primo avvio la riga "sto cercando le voci" finché la lista non è stabile.

**Voci coerenti con "Vera": risoluzione a cascata con ultimo gradino obbligatorio.** (1) lista di preferenza per nome e lingua, (2) prima voce femminile non infantile della lingua, (3) qualunque voce la cui `lang` inizia con la lingua richiesta, anche le voci "Eloquence" di iOS, (4) qualunque voce `en`/`it`. Mai una lingua senza voce; la diagnostica dice il gradino usato. Le voci con nome `undefined` (bug di Edge 150) si riconoscono da `voiceURI` e `lang` invece di essere scartate. Liste di preferenza (modificabili):

| Piattaforma | Inglese (en-GB, poi en-US) | Italiano (it-IT) | Eventi boundary |
|---|---|---|---|
| Edge Windows | Microsoft Sonia Online (Natural), Libby; poi Ava/Emma Multilingual | Microsoft Elsa Online (Natural), Isabella | Probabilmente no → orologio stimato |
| Chrome Windows | Google UK English Female (rete) oppure Microsoft Hazel/Susan (locali) | Google italiano oppure Microsoft Elsa (locale) | Google: no; locali: sì |
| Chrome/Safari macOS | Serena, Kate, poi Samantha | Federica, Alice | Sì |
| Chrome Android | Solo per lingua: la voce predefinita del motore TTS del telefono, cambiabile nelle impostazioni del telefono | idem | No |
| Safari iOS | Solo voci preinstallate; su iOS 18+ l'elenco può non avere una en-GB femminile né una compatta classica: Samantha, Karen, poi il gradino 3 | Alice, poi il gradino 3 | Sì (percorso verificato nel codice, da confermare sul dispositivo) |

Regole d'uso verificate: su Android si imposta **sempre** sia `utterance.lang` sia `utterance.voice` (la lingua parlata viene da `lang`); mai `pause()` su Android (ferma senza eventi); uno `speak()` con Chrome in background fallisce con `error`: si riprende con un tocco. Ogni segmento è spezzato per frase (≈160-200 caratteri) per evitare i tagli di Chrome sulle frasi lunghe. "Più lento" = `cancel()` e ripetizione a `rate` 0,8 (pavimento 0,7), tono invariato.

**Sblocco della voce su iOS, esatto.** Il primo `speak()` fuori da un gesto viene scartato **senza alcun evento**, e "gesto" significa il gestore sincrono del tocco: non sopravvive a un `await` di `getUserMedia` o di `response.json()`. Quindi nel gestore del tocco "inizia", prima di qualsiasi `await`: `speechSynthesis.cancel()`, poi `speak()` di un'utterance "." con `volume` 0,01 e `rate` 10 (mai testo vuoto o volume 0: incastrano la coda); solo dopo `AudioContext.resume()`, microfono, wake lock. Se 300 ms dopo uno `speak()` `speaking` e `pending` sono ancora false, la voce è bloccata e l'app chiede "Tocca per sentire Vera". Lo sblocco vale per documento: si rifà dopo ogni ricaricamento.

**Eco: half-duplex rigoroso su tutte le piattaforme.** Mentre Vera parla il riconoscimento è fermo (`abort()` prima di `speak()`, con un flag `ownAbort` che impedisce al riavvio automatico di scattare); si riapre solo dal punto "voce finita", più una coda di sicurezza (120 ms con cavo o altoparlanti, 300 ms se l'uscita sembra Bluetooth). Motivo verificato: la voce sintetica è prodotta dal sistema operativo fuori dalla pipeline audio del browser, quindi la cancellazione d'eco del browser non la "vede", e il riconoscitore nativo di Chrome desktop non ha **nessuna** cancellazione d'eco. Eccezione: Windows 11 e macOS ≥ 14.2 dove `getUserMedia({ audio: { echoCancellation: { ideal: "all" } } })` (si legge l'esito da `track.getCapabilities()`) usa il loopback di sistema, al costo di 170 ms di ritardo di cattura; lì, su Chrome/Edge ≥ 135, il riconoscitore può ricevere quella traccia con `recognition.start(track)` (traguardo 5, opzionale).

**Interruzione di Vera (barge-in).** Sempre: un tocco sullo schermo, `Esc` o barra spaziatrice su PC. In più, un rilevatore di energia vocale durante il parlato di Vera, acceso **solo** quando non c'è rischio di auto-interruzione: cuffie rilevate oppure cancellazione d'eco di sistema disponibile. "Cuffie rilevate" è una misura, non un'assunzione: nei primi 300 ms dopo `onstart` della sintesi il livello del microfono resta entro 3 dB dal rumore di fondo (nessuna perdita dagli altoparlanti), con `AudioContext.outputLatency > 0,1 s` come indizio di Bluetooth; la diagnostica mostra l'esito. Mai su Android e iOS nella v1.

**Reattività alla voce dell'utente.** Su PC: `getUserMedia` + `AnalyserNode` (RMS con attacco 40 ms e rilascio 250 ms, rumore di fondo calibrato). Su Android: **nessun secondo flusso microfono** mentre il riconoscitore di Google è attivo (verificato: due catture in conflitto e passaggio alla modalità "chiamata"); la reattività e la chiusura del varco sono guidate dall'arrivo dei risultati provvisori e finali. Su iOS: opzionale e spento; se mai attivato, `echoCancellation: true` obbligatorio (la cattura è un'unità condivisa: spegnerla toglie la cancellazione anche al riconoscimento) e `AudioContext` creato dopo il flusso. La diagnostica dice quale sorgente guida l'animazione.

**Riconoscimento, profili per piattaforma (comportamenti verificati nel codice dei browser, salvo dove indicato):**

| Piattaforma | Profilo | Fatti da gestire |
|---|---|---|
| Chrome/Edge desktop | `continuous: true`, `interimResults: true`, riavvio in `onend` | Si ferma da solo dopo ≈15 s di silenzio; `no-speech` dopo ≈8 s iniziali; on-device opzionale da Chrome 139 (`available()`/`install()` da un gesto, `processLocally`, pacchetti en-US e it-IT) |
| Chrome Android | Una frase per `start()`, riavvio in `onend` | **Probabile bip di sistema** a ogni avvio e fine di frase (segnalazioni fino al 2025, non nel codice Chromium: da verificare sul telefono); pagina nascosta o schermo spento = sessione terminata, da riavviare al ritorno con un tocco; l'audio va al servizio di riconoscimento Google, senza controllo su dove è elaborato |
| Safari iOS (scheda) | Una frase per sessione; **nuovo oggetto a ogni ascolto e dopo ogni frase di Vera** | Prefisso `webkit`; Siri/Dettatura attiva; permesso richiesto a ogni caricamento (quindi mai navigazioni di pagina intera; l'utente può impostare Safari > Impostazioni sito > Microfono = Consenti); segnalato nel 2026 che l'ascolto può morire senza eventi dopo una riproduzione audio o vocale: watchdog a ogni `start()` |
| iOS app da schermata Home | **Da provare sul dispositivo** (fino al 2024 non funzionava, bug WebKit 225298; due segnalazioni 2026 dicono che su iOS 26 parte) | Il consiglio "Aggiungi alla schermata Home" compare solo se la prova passa; altrimenti: "Su iPhone usa Vera dalla scheda di Safari: lì ti ascolta" |
| Firefox, Chrome/Edge su iOS | Non ascoltano (costruttore presente ma non funzionante) | Modalità testo |

Regole universali: cambio lingua = nuovo oggetto con la lingua richiesta da `listen.lang`; si leggono solo `event.results[event.resultIndex…]`, si conferma solo `isFinal`, mai concatenare i trascritti di eventi successivi (duplicati visti su iOS e Android); `onnomatch` trattato come `no-speech`; watchdog su **ogni** `start()`: senza `onstart`/`onaudiostart` entro 3 s si ricrea l'oggetto e si riprova una volta, poi "Tocca per riprovare"; timeout di sessione (iOS 20 s di silenzio; Android si fida del servizio); tetto ai riavvii (10 al minuto, stop dopo 5 `no-speech` consecutivi); la causa di ogni `onend` è registrata nella diagnostica.

**Errori del riconoscitore, uno per uno:**

| Codice | Azione | Messaggio | Stato del telaio |
|---|---|---|---|
| `no-speech` | riavvio silenzioso con backoff e conteggio | nessuno; dopo 5 di fila: "Non ti sento: tocca per riprovare" | varco chiuso |
| `aborted` | riavvio solo se non è il nostro `abort()` | nessuno | — |
| `audio-capture` | stop | "Nessun microfono: controlla cuffie o Bluetooth" | fili annodati |
| `not-allowed` | stop (su iOS può anche significare pagina non visibile) | passi esatti per il browser in uso, "Riprova", "Oppure scrivi" | MICROFONO CHIUSO |
| `service-not-allowed` | stop | "Attiva Siri o la Dettatura" (iOS) / passaggio a testo | — |
| `network` | backoff 1/2/4 s, max 5 | "Il riconoscimento ha bisogno di rete" | SENZA RETE |
| `language-not-supported` | tag alternativo, poi senza `processLocally` | "Lingua non disponibile su questo dispositivo" | — |

**Le frasi di aiuto, tre percorsi diversi perché sono problemi diversi.** "Ripeti" e "più lento" sono **locali**: l'app annulla la voce e ridice l'ultimo segmento (a 0,8 per "più lento", modalità lenta persistente per la sessione), senza chiamare il modello. "Non ho capito": la prima volta è locale (stesso segmento più lento); la seconda va al modello con `help: "DIDNT_UNDERSTAND"` (riformulazione più corta e glossa italiana). "Come si dice…": al riconoscimento del prefisso o al tocco della parola sullo schermo, l'app apre un ascolto in `it-IT` per la sola richiesta ("Dimmelo in italiano"), poi manda al modello `help: "HOW_TO_SAY"` con il testo italiano e torna alla lingua prevista. Il riconoscimento del prefisso usa un matcher tollerante (distanza di Levenshtein normalizzata su varianti in entrambe le lingue, perché un riconoscitore inglese deforma l'italiano); le tre azioni esistono sempre anche come parole toccabili. Tutti gli eventi di aiuto entrano nel registro e nelle metriche. Limite onesto: mentre Vera parla il microfono è chiuso, quindi sul telefono l'aiuto in quel momento si chiede con un tocco (su PC con cuffie anche a voce).

**Scartato.** VAD neurale (Silero via onnxruntime: ≈13 MB, fallimenti noti su iPhone). Full-duplex generalizzato. Riconoscimento via registrazione + STT cloud nella v1 (richiede un'altra chiave; l'interfaccia lo prevede e sale di priorità se il telefono è un iPhone). Il trucco `pause()/resume()` per i tagli di Chrome (rompe Android).

### 1.3 Il protocollo del turno (la risposta strutturata)

Ogni risposta di Vera è un oggetto JSON validato da schema. Risolve la trappola delle due lingue: ogni pezzo dice in che lingua è, e la risposta dice in che lingua ascoltare dopo. Schema completo (i commenti non fanno parte dello schema):

```jsonc
{
  "segments": [                       // ciò che Vera dice, in ordine; voce scelta per lingua; il primo è breve per contratto
    { "lang": "IT" | "EN", "kind": "SAY" | "ASK" | "MODEL", "text": "…" }   // MODEL = la frase inglese da far ridire
  ],
  "listen": {
    "lang": "EN" | "IT",
    "expect": "REPEAT" | "ANSWER" | "FREE",
    "target": "Could I have the bill, please?",        // presente con REPEAT
    "alternatives": ["Can I have the bill, please?"]    // varianti accettate
  },
  "correction": {                     // al massimo una riga corretta per turno, con al massimo 2 modifiche (il diff lo calcola l'app)
    "heard": "I have thirty years", "correct": "I am thirty years old", "note_it": "L'età in inglese si dice con to be."
  } | null,
  "items": [ { "kind": "PHRASE" | "ERROR", "id": "p_042", "signal": "FAILED" | "HARD" | "PRODUCED" | "SPONTANEOUS" | "NOT_OBSERVED" } ],
  "learned": [ { "text_en": "…", "gloss_it": "…", "topic": "TRAVEL" | "TABLE_AND_STAY" | "CITY_AND_TROUBLE" | "SMALL_TALK" } ],
  "about_learner": [ { "fact": "Va a Londra a marzo con la moglie", "topic": "TRIP" } ],   // max 1 per turno; unito nel profilo
  "goal": { "id": "g_restaurant_bill", "status": "ONGOING" | "DONE" },
  "closing": { "remember": ["…", "…", "…"] } | null     // solo quando l'app passa phase = CLOSING
}
```

`listen.lang` imposta la lingua del riconoscitore prima di riaprire il microfono. `expect: "REPEAT"` è una preferenza, non un blocco: attiva il confronto parola per parola con `target` e `alternatives`, ma se l'utente dice altro la conversazione prosegue. Il diff tra `heard` e `correct` (sostituzioni, inserimenti, cancellazioni, massimo 2, altrimenti sostituzione dell'intera riga) lo calcola `src/core/turn/`, mai il modello (gli indici generati dal modello erano il campo più fragile). Le fasi della sessione (`phase`) e i trigger di chiusura li decide l'app e li comunica nella scheda (vedi 1.4): il modello non ha un orologio.

### 1.4 Memoria e didattica

**Ripetizione spaziata: FSRS-6** tramite `ts-fsrs` 5.x (MIT, zero dipendenze, ≈60 KB), parametri predefiniti (mediana di 10.000 utenti Anki; sul benchmark pubblico battono anche SM-2 calibrato per utente). Configurazione: `request_retention: 0.9`, `maximum_interval: 180` (tutto resta osservabile nei sei mesi), `enable_fuzz`, `enable_short_term`, `learning_steps: ["2m", "8m"]` (riuso dell'elemento nuovo più avanti nello scenario e nella chiusura), `relearning_steps: ["5m"]`; lo stato delle carte si ricalcola dal registro dei ripassi (`reschedule`), così la sincronizzazione non può corromperlo. FSRS-6 arrotonda ai giorni interi: più sessioni nello stesso giorno passano dal ramo a breve termine. Stesso scheduler per **frasi** (test: produrla quando la situazione la richiede) ed **errori** (test: il prossimo contesto obbligatorio). Mappatura dei segnali: `FAILED` e "corretto solo dopo un suggerimento esplicito" → Again; `HARD` (corretto dopo una richiesta di chiarimento) → Hard; `PRODUCED` → Good; `SPONTANEOUS` → Easy (max uno a settimana per elemento); `NOT_OBSERVED` → nessun voto. Regola ferrea (manuale Anki): un fallimento al primo tentativo non è mai Hard. Un errore "sparisce" quando è in stato Review, stabilità ≥ 30 giorni, 3 riuscite consecutive e nessuna ricaduta nelle ultime 5 occasioni; resta in sorveglianza passiva e si riattiva se ricompare. Riserva senza dipendenze: scala fissa 1/3/7/14/30 giorni.

**Validazione dei voti (il rischio numero uno secondo la letteratura: il modello troppo generoso).** Ogni segnale è registrato accanto alla trascrizione e alla frase bersaglio; nelle prime due settimane d'uso si rivedono 50 turni; soglie di sanità nell'etichetta di composizione: `NOT_OBSERVED` < 40% degli elementi mirati, Again tra 5% e 25%; interruttore "voti semplici (Again/Good)" se Hard ed Easy risultano inaffidabili.

**Correzione: una sequenza sola.** (1) Nel turno in cui sente l'errore, Vera risponde con un recast naturale e, nella pagina, la parola sbagliata diventa quella giusta sotto gli occhi dell'utente; (2) la riga corretta diventa fantasma con "Ora dilla tu" e Vera la fa ridire (come chiede il brief): **questa ripetizione non è mai votata**, serve a fissare la forma; (3) alla battuta successiva Vera fa una domanda la cui risposta richiede la forma corretta in una frase nuova: **è questa produzione che vale un voto** (la ricerca mostra che la produzione guidata predice l'apprendimento, la ripetizione no); (4) se l'utente non ripete e dice altro, la riga fantasma si commette a peso leggero senza penalità e la conversazione prosegue; (5) dopo due tentativi falliti Vera passa oltre. Una sola riga corretta per turno, con al massimo due modifiche; priorità se ce ne sarebbero di più: errore già in scheda > forma del micro-obiettivo di oggi > errore che compromette la comprensione; il resto passa. Gli errori lessicali non ricevono spiegazioni, solo recast e riuso; il suggerimento di una riga in italiano arriva solo alla seconda ricaduta di un errore di regola. **La scheda errore la crea l'app, non il modello:** ogni correzione diventa un evento con chiave normalizzata (forma bersaglio + tipo); la scheda dello studente porta le "correzioni recenti non ancora in scheda" (≤ 5, ultimi 14 giorni); quando la stessa chiave ricompare nasce la scheda errore; gli errori che compromettono la comprensione vanno in scheda alla prima occorrenza.

**Sessione da 5-10 minuti, con le fasi guidate dall'app.** La macchina a stati in `src/core/session/` decide la fase in base al tempo trascorso e alle battute completate e la passa nella scheda (`phase`, `elapsed_s`, `beats_done`). Preset 10 minuti: riscaldamento 1-2 minuti (2-4 elementi in scadenza come mini-domande), scenario 5-6 minuti con un micro-obiettivo concreto in 3-4 battute, ciascuna con un criterio di riuscita (Vera parla al massimo due frasi per turno; obiettivo: l'utente parla almeno il 50% del tempo), chiusura 1-1,5 minuti. Preset 5 minuti: riscaldamento 1, scenario a 2 battute, chiusura 1. **Chiusura "tre cose":** quando il tempo supera l'obiettivo meno 90 s o l'ultima battuta è completata, il turno successivo porta `phase: "CLOSING"`: Vera chiede "dimmi tre cose che sai dire adesso", l'utente le produce (richiamo attivo, ciascuna conta come ripasso) e `closing.remember` è la lista riformulata da Vera dopo il richiamo, più l'unico errore da tenere d'occhio. Fine esplicita con la pressione lunga: chiusura breve ≤ 30 s. Interruzione (schermo spento, app chiusa): solo checkpoint; le tre cose si recuperano in testa alla ripresa. Massimo 6 elementi mirati per sessione; se il tasso di Again supera il 30% nelle ultime 3 sessioni, nessuna frase nuova finché non scende sotto il 20%.

**Giornata da 45 minuti.** Un pianificatore nel core sceglie il tipo della sessione successiva: 4-6 sessioni al giorno, al massimo 2 con micro-obiettivo nuovo, le altre varianti e ripassi; "sessione facile" (scenario padroneggiato più una frase nuova) se due sessioni di fila vanno male (Again > 35% o parlato < 30%); rifacimento di uno scenario della prima settimana ogni 4 settimane.

**Ripresa.** Checkpoint dopo ogni turno (scenario, battuta, ultima frase di Vera, correzione in sospeso). Entro 2 ore: stessa battuta con un riassunto di una riga; oltre: sessione nuova con riscaldamento e proposta di finire lo scenario.

**La stampella italiana che cala.** Quota di italiano nelle parole di Vera, misurata per sessione e data al modello come obiettivo: A0 (settimane 1-4) ≤ 65%, A1 ≤ 40%, A1+ ≤ 20%, A2 ≤ 12%. Promozione per evidenza: ≥ 80% dei micro-obiettivi del livello completati senza aiuto e Again < 20% negli ultimi 14 giorni. Il cursore "più italiano ↔ più inglese" nelle impostazioni è un offset limitato (± 15 punti) sulla quota del livello, mai un sostituto. Le richieste di aiuto non sono mai penalizzate.

**Micro-obiettivi.** Lista iniziale di 30-40 voci con livello A0 / A1 / A1+ / A2 e glossa italiana, nei domini aeroporto, hotel, ristorante, indicazioni e trasporti, negozi, imprevisti ed emergenze, chiacchiere; le formulazioni CEFR vanno verificate prima di pubblicarle (fonti non raggiungibili durante la ricerca). Gli scenari si generano dentro il turno della sessione che li usa, non tutti in anticipo.

**Primo avvio, in sequenza.** Tocco "inizia" → sblocco della voce → permesso microfono → 4-5 domande in italiano (viaggi in programma, dove, con chi, interessi, situazioni che preoccupano) con risposte scritte nel profilo (`chi sei`) → una chiamata che ordina i micro-obiettivi per priorità → prima sessione. "Rifai le domande" nella sezione dati.

**Si ricorda di te.** Oltre a livello, elementi in scadenza ed errori, il profilo ha una sezione `chi sei` (≤ 80 token: viaggio, compagni, interessi, paure) alimentata dal primo avvio e dal campo `about_learner` della risposta (max 1 fatto per turno, tetto di 20 fatti, i più vecchi escono), visibile e modificabile nella sezione dati.

**Progresso senza punteggi.** Il corpo di Vera (1.7) più una vista "Progresso" che si apre toccando il ritratto: lista "ora so dire" (micro-obiettivi con almeno uno scenario completato senza aiuto), errori scomparsi (le righe che hanno avuto e perso il colore di correzione, con la forma sbagliata barrata e la data), frasi prodotte senza aiuto questa settimana, tempo di parola in salita, aiuti in calo, ultimo rifacimento. Il tempo di parola è dichiarato "stimato": somma degli intervalli primo risultato provvisorio → risultato finale per l'utente, `onstart` → `onend` (o orologio stimato) per Vera. Mai mostrati: stabilità FSRS, conteggi di Again, penalità.

**Pronuncia.** Solo "intelligibilità": sulla frase bersaglio, se il riconoscitore ha sentito le parole giuste (o una delle `alternatives`) in 2 tentativi su 3, è intelligibile; mai un giudizio fonetico. Controllo settimanale di coppie minime note per italiani (ship/sheep, h di hotel, th, la vocale finale aggiunta) in cornici neutre.

**Scheda dello studente nel prompt** (≤ 400 token, rigenerata dall'app, posta dopo il breakpoint di cache): livello con evidenza; `chi sei`; micro-obiettivo, battute, `phase`, `elapsed_s`, `beats_done`; elementi in scadenza (≤ 6); errori attivi (≤ 3) e correzioni recenti non in scheda (≤ 5); preferenze (lento, quota di italiano, nome); riassunto dell'ultima sessione (3 righe); checkpoint se in ripresa; metriche.

**Scartato.** SM-2 e Leitner (meno calibrati di una costante sul benchmark). Flashcard esplicite (la ripetizione avviene dentro la conversazione). Strumento memoria lato server.

### 1.5 Dati, persistenza, sincronizzazione tra PC e telefono

**Locale.** IndexedDB con un **registro eventi append-only** e uno snapshot derivato; localStorage per preferenze, chiave e calibrazioni. Ogni evento ha `(device_id, seq)`, timestamp e id; il replay è deterministico (ordinato per timestamp e id) e lo stato FSRS si ricalcola dal registro dei ripassi. `navigator.storage.persist()` chiesto in modo opportunistico (Chrome lo concede alle PWA installate; Safari solo alle app da schermata Home). Fatto verificato nel codice di WebKit: Safari su iPhone cancella lo storage di un sito dopo 30 "giorni di uso del browser" senza interazione (7 nei casi di tracciamento); l'esenzione per le app da schermata Home è nel codice di WebKit ed è probabile, non certa, che iOS la applichi. Quindi il locale è una cache: la copia remota o l'export è la verità. Lo stesso vale per il token e la chiave in una scheda Safari.

**Sincronizzazione predefinita: un repository privato GitHub come archivio dati**, scritto e letto dal browser con la Contents API. CORS di `api.github.com` verificato con test live (`GET`/`HEAD`); la preflight per `PUT` è da documentazione: **il primo passo del traguardo 4 è un `GET`/`PUT` reale dall'origine Pages** da Chrome, Android e iPhone. Setup una tantum (≈5 minuti): creare un repo privato vuoto (per esempio `english-vera-data`), creare un fine-grained personal access token limitato a quel solo repository con permesso `Contents: Read and write` (scadenza fino a 366 giorni o nessuna), incollarlo a mano nell'app su ogni dispositivo (niente QR nella v1: una libreria in più e il rischio di finire in una URL). Meccanica: `GET` con `If-None-Match` e `cache: "no-cache"` (la risposta porta `Cache-Control: max-age=60` e un `GET` dalla cache darebbe uno `sha` vecchio); unione per id; `PUT` con lo `sha` letto; **409** (famiglia: `sha` superato, corsa sul branch, regole del repo) → rileggi, riunisci, riprova con jitter, massimo 5 volte poi "conflitto, riprova più tardi"; **422** non è un conflitto (validazione, `sha` mancante, spam) → nessun retry, errore mostrato; 403/429 → rispettare `Retry-After` e sospendere; 401 → token scaduto o revocato, chiedere di rinnovarlo. **Quando:** `GET` all'avvio e prima del primo turno (così "riprendo dal telefono dove ero sul PC" funziona entro le 2 ore), `PUT` a fine turno con debounce di 10 s, a fine sessione e su `visibilitychange`; mai a cadenza fissa. File mensili (`events-2026-10.jsonl`) e compattazione sopra ≈150 KB con `compacted_until` per dispositivo, così gli eventi già compattati non vengono riapplicati da un altro dispositivo. Raggio d'azione in caso di furto del token: un solo repo privato di dati. Nessun header `X-GitHub-Api-Version` dal browser (non è nella lista CORS). "Ultima sync" e dimensione nell'etichetta di composizione; bottone "Dimentica token".

**Sempre disponibile: esporta/importa JSON** ("porta via la stoffa"): Web Share con file su telefono, download su PC, import con unione per id, mai sovrascrittura di progressi più recenti. Chiave e token non entrano mai nell'export (test).

**Rinviato.** Cifratura dei dati nel repo (AES-GCM con passphrase): il repo è già privato.

**Scartato e perché.** Gist (verificato: un fine-grained token può leggerli, ma i gist "segreti" sono leggibili da chiunque abbia l'URL e la PATCH non ha controllo di concorrenza). Google Drive appData (client OAuth in Google Cloud Console; token da 1 ora senza rinnovo silenzioso). Dropbox (setup di un'app). WebDAV/Nextcloud (niente CORS di default). File System Access API (solo Chromium).

### 1.6 Pubblicazione, installazione, sicurezza della pagina

**GitHub Pages** (repo pubblico: piano gratuito) con GitHub Actions: job `check` (typecheck, lint, test unitari, build), job `e2e` (Playwright con `npx playwright install chromium`, screenshot come artefatti), job `deploy` (`actions/configure-pages`, `actions/upload-pages-artifact` su `dist`, `actions/deploy-pages`, `permissions: pages: write, id-token: write`, `concurrency: pages`). Vite con `base: '/english-vera/'`; nessun routing per percorso. **Branch di pubblicazione:** il deploy parte da `main`; quando vuoi pubblicare mi chiedi di aprire la pull request dal branch di lavoro, oppure aggiungi il branch di lavoro tra i "Deployment branches" dell'ambiente `github-pages` per pubblicare direttamente da lì. **Passo manuale:** Settings > Pages > Source = "GitHub Actions" prima del primo deploy.

**Content Security Policy** come `<meta http-equiv>` (Pages non permette header): `default-src 'self'; connect-src 'self' https://api.anthropic.com https://api.github.com; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'`. Niente script inline (il service worker è registrato dal bundle, `injectRegister: null`), nessuno script esterno, Workbox non mette mai in cache le API; un test in CI verifica che `dist/index.html` non contenga script inline. I messaggi d'errore passano da un filtro che oscura `sk-ant-…` e `github_pat_…` prima di essere salvati o copiati (test unitario).

**PWA** con `vite-plugin-pwa` (Workbox, `registerType: 'prompt'`: l'aggiornamento si applica **solo nello stato Riposo** con una riga "Vera si è aggiornata", mai a metà sessione, perché un ricaricamento taglierebbe voce e ascolto e su iPhone azzererebbe lo sblocco della voce e il permesso del microfono); precache di app, icone e font; manifest con `id`, icone 192/512 e maskable, `apple-touch-icon`, meta per iOS. Android: pulsante "Installa" via `beforeinstallprompt`; vibrazione di 10 ms all'apertura e alla chiusura dell'ascolto dove disponibile. iOS: istruzione "Condividi > Aggiungi alla schermata Home" mostrata **solo dopo che la prova dell'ascolto in app installata è passata**. Durante la sessione: `navigator.wakeLock` chiesto nel tocco di avvio (su iOS funziona nelle app da schermata Home solo da iOS 18.4) e riacquisito su `visibilitychange`.

**Onestà sul telefono.** Con lo schermo spento il riconoscimento muore su Android e su iOS: nessuna app web può prometterlo. Il wake lock tiene lo schermo acceso; l'app lo dice al primo avvio e, se il sistema spegne lo schermo, al ritorno dice "Mi ero fermata: lo schermo si è spento" e riprende dall'ultima frase con un tocco. Il tasto delle cuffie (Media Session con un audio silenzioso in loop) è sperimentale, spento di default e **spento su iOS** finché non è provato: proprio una riproduzione audio è il tipo di evento che su iOS rompe la sessione di ascolto.

**Font.** Self-hosted via `@fontsource-variable` (licenza OFL, file di licenza nel repo), sottoinsieme latino, precache; `font-display: block` con fallback a metriche compatibili (`size-adjust`).

### 1.7 Identità visiva: "Vera al telaio"

Quattro concept sono stati sviluppati in parallelo (l'organismo tipografico del tuo seed, "Corpus"; un tabellone a palette di stazione, "Partenze"; una pagina composta a mano, "La Forma"; il telaio, "Trama") e giudicati da tre lenti (direzione creativa, ingegnere front-end, l'utente). Punteggi: Trama 136, Corpus 132, Partenze 131, La Forma 112. I testi integrali e i giudizi sono in `docs/ricerca/`. **Proposta: il telaio, con innesti da Corpus, Partenze e La Forma.** È l'unico concept in cui ogni stato è un gesto meccanico riconoscibile anche da fermo, il più economico da far girare a 60 fps su un telefono di fascia media, e quello in cui il passaggio dall'italiano all'inglese ha una forma strutturale. Rispetto al seed: il corpo resta "fatto delle frasi imparate", ma ordinate come una stoffa che si allunga e si infittisce, così la crescita si legge come lunghezza e densità.

**L'idea.** L'ordito verticale è il tuo italiano, teso prima che tu cominci. La trama orizzontale sono le frasi inglesi che **tu** dici correttamente: una riga per frase, battuta dal pettine. Le parole di Vera non diventano stoffa: la sua riformulazione è un filo guida alla linea di battuta e diventa tessuto solo quando la dici tu. La stoffa è ciò che sai dire, non ciò che hai sentito.

**Anatomia (niente telaio di legno disegnato, solo le parti che lavorano).** Dall'alto: il **pettine**, una barra di dentini verticali che porta l'etichetta di stato, grande (≥ 20 px su telefono: i tre giudici hanno bocciato all'unanimità le etichette piccole); la **linea di battuta**, dove nasce ogni riga nuova e dove sta, in grande, quello che dici; la **stoffa**, che cresce verso il basso e si scorre; la **cimosa** a sinistra, con un nodo per ogni sessione (niente numeri, niente fiammelle); il **rotolo** in fondo, che si ispessisce con la stoffa arrotolata. L'ordito corre attraverso tutto, ma **sopra il testo solo nei margini**: l'intreccio sopra le lettere a 15 px era la bandiera rossa comune; si prototipa per primo e, se disturba, resta fuori dal testo.

**Crescita, con una sola fonte di verità.** Il peso del carattere e l'opacità di ogni riga derivano dallo stato FSRS della frase, non da un contatore separato: 300 = in apprendimento o richiamo stimato basso, 500 = in revisione, 700 = in revisione con stabilità ≥ 30 giorni; opacità dalla probabilità di richiamo. Così la stoffa e lo scheduler non possono dire due cose diverse. Giorno 0: solo l'ordito e una riga fantasma: "La prima riga la tessi tu." Dopo la prima sessione: 6-10 righe sottili. Un mese: una sciarpa. Sei mesi: una stoffa lunga, scura, quasi solo inglese. L'opacità dell'ordito è la quota di italiano nelle parole di Vera negli ultimi turni: l'impalcatura si ritira dietro la stoffa. Toccando una riga, sotto compare la traduzione italiana con "ascolta" e "ritessi". Innesto da Corpus: il **ritratto**, una miniatura della stoffa (20×96 px su telefono accanto al nome) in cui ogni riga è un tratto lungo quanto la frase e scuro quanto il suo peso: il progresso a colpo d'occhio, l'immagine da condividere e la porta della vista "Progresso".

**Stati, nettamente diversi anche con "riduci animazioni":**

| Stato | Geometria | Etichetta | Con movimento | Con movimento ridotto |
|---|---|---|---|---|
| Ascolta | L'ordito si apre in un varco a losanga alla linea di battuta; il trascritto grande entra nel varco | ASCOLTO | Su PC i fili vibrano con la tua voce (0-4 px) e il varco si chiude lentamente (320 ms) dopo il silenzio: vedi che "ho finito" è stato capito; su telefono la chiusura è guidata dall'arrivo del risultato finale | Varco aperto statico; il filo sotto la parola corrente cambia spessore a scatti (1/2/3 px, max 4 volte al secondo) |
| Pensa | Varco chiuso, pettine alzato, filo guida tratteggiato che misura la riga avanti e indietro | VERA PENSA | Il filo guida viaggia (1,2 s per attraversata); oltre 6 s compare "ci sto mettendo più del solito" | Filo tratteggiato statico; oltre 4 s un secondo tratteggio |
| Parla | Pettine abbassato che batte; **ogni segmento** della risposta appare intero a bassa opacità appena si chiude nel JSON e si "inchiostra" parola per parola mentre la voce lo legge; la parte non ancora arrivata resta filo guida | VERA PARLA | Navetta che precede la parola corrente; battuta di 3 px per parola | Parole che si scuriscono una per una, senza spostamenti |
| Corregge | Sulla tua riga grande la parola sbagliata diventa un nodo e si trasforma in quella giusta, in robbia; poi la riga corretta sale e diventa fantasma a contrasto pieno con contorno tratteggiato, sotto la didascalia "Ora dilla tu" | RIPETI | Se le due parole condividono ≥ 40% delle lettere, morfosi lettera per lettera (innesto da Corpus: "peoples" → "people" toglie solo la s, sotto 1 s); altrimenti barratura e parola giusta impilata sopra, ≤ 900 ms (la "disfatta" lettera per lettera del concept resta un'opzione da collaudare con te); durante la ripetizione le parole del fantasma si riempiono quando combaciano, allineate in colonna con quelle che dici (innesto da Partenze) | Parola sbagliata barrata e parola giusta impilata sopra, in robbia; poi riga ridisegnata |
| Riposo | Nessuna riga aperta, navetta agganciata in verticale, la stoffa è il contenuto | — | Nessun effetto decorativo (la "luce da finestra" del concept è tolta: era un gradiente e un cliché da app di meditazione) | Statico |

La battuta più forte sulle sillabe toniche del concept è tolta dalla v1: richiederebbe un dizionario di accento lessicale che non c'è. Regola di colore innestata da Corpus: **il colore di correzione compare solo quando sbagli e sparisce quando ripeti bene**; una sessione senza errori non contiene mai rosso. Gli errori di sistema (chiave, rete, microfono, budget) non usano mai il colore di correzione.

**Tipografia.** Due lingue, due voci: **inglese = sans dritto, italiano = serif corsivo**, la lingua si riconosce dal carattere e non dal colore. Inglese e interfaccia: Bricolage Grotesque, scelto per gli assi che servono davvero (peso = consolidamento; dimensione ottica e larghezza: stretta a 15 px nelle righe della stoffa, rilassata a 34-56 px nel trascritto); nel giro di screenshot del traguardo 1 si prova anche un'alternativa con gli stessi assi, e la **prova brutale** (uno screenshot senza il corpo deve essere ancora Vera) ha un verdetto scritto nel CLAUDE.md. Italiano: Newsreader corsivo (variabile con dimensione ottica), scelto al posto di Fraunces perché la coppia Fraunces + carta avorio è diventata il template del 2025-26. Regole: l'italiano non è mai in grassetto, l'inglese mai in corsivo; niente Inter, Roboto, Arial, niente monospace. Scale: trascritto 34 px telefono / 56 px desktop; righe della stoffa 15-16 px; etichetta di stato 20 px; cifre tabellari per i costi. Sottoinsiemi latini, preload, `size-adjust` sui fallback; compensazione di peso in tema scuro.

**Colore.** Lino e tinte da tintoria naturale, opache, niente gradienti, vetro, blur o viola. Chiaro "lino": sfondo `#F2EEE6`, inchiostro `#2A2622`, Vera indaco matto `#2E3A66`, correzione robbia `#B0303A`, parola sbagliata grigio-fibra `#9B8B7A`, ordito `#B3935F` che sbiadisce. Scuro "lana di notte": sfondo `#171513`, inchiostro `#EDE6D8`, Vera `#A9B8E6`, correzione `#E2645A`, ordito `#6E5A3C` con pavimento al 12% di opacità. Tinte per argomento ridotte a **tre** (viaggio e trasporti; tavola e alloggio; città e imprevisti) più il neutro per le chiacchiere, ognuna in due valori (filo e inchiostro ≥ 4,5:1). Token su `:root`, tema scuro sotto `prefers-color-scheme` e `[data-theme]`.

**Movimento.** Due curve soltanto (assestamento smorzato per pettine e varco; navetta lineare con frenata finale). Tutto ciò che si muove è `transform`/`opacity`; un solo Canvas 2D per l'ordito nella zona di battuta, `requestAnimationFrame` attivo solo in Ascolta e Pensa; stoffa in DOM statico con `content-visibility` e virtualizzazione oltre 300 righe; span per lettera solo per le due parole in correzione. Innesto da Partenze: misurazione del tempo di frame nei primi 3 s di sessione e, sopra 20 ms medi, passaggio automatico alla coreografia ridotta; debounce di 120 ms sui risultati provvisori e aggiornamento delle sole parole cambiate. `prefers-reduced-motion` e interruttore manuale rispettati come da tabella.

**Animazione "mentre parla" senza l'audio.** Driver primario: `onboundary` (parola). Driver di riserva sempre pronto: un orologio stimato (90 ms + 70 ms per sillaba in inglese, 80 + 60 in italiano, diviso per `rate`, più pause di punteggiatura) che parte a `onstart`, si riallinea con uno snap a ogni boundary reale e si chiude a `onend`; se `onend` arriva prima del previsto le parole residue si completano in 120 ms, se arriva dopo l'ultima parola resta attiva; un fattore di calibrazione per voce (media mobile esponenziale in localStorage) riduce l'errore sotto il 10% dopo 2-3 frasi. Nelle prime due frasi per voce l'ingresso è a gruppi di parole, più discreto. La diagnostica dice "boundary: sì / no / stimati · calibrazione 0,94".

**Stati vuoti e di errore, disegnati.** Primo avvio: ordito teso, due capi di filo da annodare ("Chiave", con convalida immediata e l'avviso sull'origine condivisa, e "Voce", come provini con frase di prova), poi la riga fantasma. Microfono negato: fili annodati alla linea di battuta, pettine "MICROFONO CHIUSO", passi esatti per il browser in uso, "Riprova", e **"Oppure scrivi"** sempre disponibile. Offline: l'ordito perde tensione (catenarie), "SENZA RETE", modalità ripasso (tocchi le righe, Vera le dice con le voci locali, tu ripeti). Errore API: il filo guida si spezza, "FILO SPEZZATO", causa in italiano in una riga dalla tabella di 1.1, "Riannoda"; la tua frase resta nel varco. Browser che non ascolta: "Qui posso parlare ma non ascoltarti" più la modalità a tastiera; su iPhone, se l'app installata non ascolta: "Usa Vera dalla scheda di Safari".

**Impostazioni, costo e diagnostica = l'"etichetta di composizione"** cucita nella cimosa: superficie di lino, bordo a punto di cucitura, titoli in corsivo. Sezioni: voce (provini, velocità), lingua (cursore italiano ↔ inglese come offset, con l'ordito che sbiadisce in anteprima), microfono (prova), chiave (solo "presente · ultime 4 cifre · convalidata il …", mai il valore), modello e listino (con data), tema, movimento, dati (esporta, importa, sincronizza, "chi sei", "rifai le domande", "dimentica chiave/token"), costo (oggi · sessione · totale in dollari, etichetta "stima", budget giornaliero con filo che diventa inchiostro con filetto sopra budget, mai rosso), e **composizione**: la diagnostica copiabile. Contenuto: versione e hash di build; browser, sistema, modalità (scheda / app installata); lingua in ascolto, profilo del riconoscitore e causa dell'ultimo `onend`; voci disponibili, scelte e gradino di risoluzione (locale/rete); microfono (permesso, livello, rumore di fondo, sorgente della reattività, esito del rilevamento cuffie); cancellazione d'eco in uso; rete; modello e listino; tempi dell'ultimo turno (fine parlato → prima parola → inizio voce); boundary sì/no/stimati e calibrazione; ultimi errori con codice e ora (filtrati dai segreti); segnali FSRS recenti con trascrizione; righe e sessioni totali; spazio usato; stato della sincronizzazione; wake lock e Media Session. "Copia etichetta" produce testo semplice a due colonne con puntini di guida, incollabile in una mail; "mostra grezzo" rivela lo stesso JSON sulla stessa carta: mai una console nera.

**Modalità tasca (opzionale, traguardo 4, solo telefono).** Entrata **esplicita** (voce nelle impostazioni o comando vocale "modalità tasca"), mai a tempo; uscita con un tocco e conferma vocale. Layout a contrasto massimo e luminosità minima con la sola etichetta di stato a 40 px e il trascritto a 24 px; i tocchi sull'etichetta e sull'area "interrompi" restano sempre attivi (la pressione lunga interrompe Vera); earcon per stato (pizzico di filo all'apertura del varco, doppio pizzico alla correzione, generati con Web Audio); Vera dice sempre tutto a voce, comprese le correzioni ("non goed: went"), con l'opzione "ripete le correzioni due volte".

---

## 2. Dove funziona bene e dove ha limiti

| | PC Chrome/Edge (Windows, macOS) | Android, Chrome (anche installata) | iPhone, Safari |
|---|---|---|---|
| Ascolto | **Ottimo.** Continuo, con risultati provvisori; riavvio automatico; on-device opzionale su Chrome 139+ | **Buono.** Una frase per volta con **probabile bip di sistema** a ogni avvio e fine (segnalato fino al 2025, da verificare sul tuo telefono); audio al servizio Google; schermo acceso obbligatorio | **Scheda Safari: la via consigliata nella v1** (una frase per volta, Siri attiva, permesso a ogni apertura salvo impostazione del sito). **App da schermata Home: da verificare sul tuo iPhone**; se non ascolta, l'app rimanda alla scheda di Safari |
| Tempo di risposta (fine parlato → voce) | Obiettivo ≤ 2 s (mediana), misurato | ≈ 2-5 s: la fine della frase la decide il servizio Google | ≈ 1,5-3 s |
| Voce di Vera | **Ottima** su Edge (voci "Natural" Sonia + Elsa, se Edge le espone con nome corretto); buona su Chrome (voci Google o di sistema) | **Dipende dal telefono**: voce predefinita del motore TTS per lingua, cambiabile nelle impostazioni del telefono, non nell'app | **Limitata**: solo voci preinstallate, forse nessuna inglese britannica femminile; primo tocco obbligatorio |
| Animazione "mentre parla" | Sincronizzata (voci locali) o stimata (voci in rete) | Stimata | Sincronizzata (da confermare sul dispositivo) |
| Interruzione di Vera a voce | Sì con cuffie, o su Windows 11 / macOS 14.2+ | Solo con un tocco | Solo con un tocco |
| Aiuto mentre Vera parla | Tocco, o voce con cuffie | Tocco | Tocco |
| Reattività alla tua voce | In tempo reale (Web Audio) | Dai risultati provvisori del riconoscitore | Opzionale |
| Auricolari Bluetooth | Ok | Ok (l'app non apre un secondo microfono) | Mentre ascolta, le cuffie passano al profilo telefonico (qualità più bassa) e la voce di Vera può risultare più bassa: da misurare |
| Telefono in tasca | — | Con schermo acceso (wake lock); muore se lo schermo si spegne | Con schermo acceso solo da iOS 18.4 nell'app installata; muore con lo schermo spento |
| Installazione | Icona nella barra dell'indirizzo | Prompt di installazione, icona, vibrazione; tasto cuffie sperimentale | Condividi > Aggiungi alla schermata Home (consigliato solo se la prova passa); niente vibrazione |
| Dati | Durevoli; sync via repo | Durevoli; sync via repo | Safari cancella lo storage dopo 30 giorni senza uso: la sync o l'export sono necessari |
| Verdetto | Prima classe | Buona, con il bip e un tempo di risposta che dipende dal sistema | Scheda: sufficiente. App installata: da provare. Se non basta: registrazione + riconoscimento cloud (altra chiave), già previsto dall'interfaccia |

Firefox e Chrome/Edge su iPhone: Vera parla ma non ascolta; modalità testo.

---

## 3. Architettura del codice

**Stack.** Vite 8 + TypeScript 7 strict, senza framework UI (una macchina a stati esplicita scrive `data-state` sulla radice e il CSS ne deriva; moduli con funzioni di rendering DOM; Preact resta un'opzione per i pannelli se la verbosità lo giustifica). Vitest 5 per il core e per i parser; Playwright 1.63 con il Chromium headless della macchina per prove d'interfaccia e screenshot (riconoscitore e sintesi finti iniettati con `addInitScript`, API Claude intercettata con `page.route`); Biome per lint e formattazione; `vite-plugin-pwa` 1.3; `@anthropic-ai/sdk` 0.131 (con un cast tipizzato isolato per `thinking` se i tipi non contemplano `between_tools`); `ts-fsrs` 5.x. Nessun'altra dipendenza di runtime. Comandi: `npm run dev`, `npm run check` (typecheck + lint + test + build), `npm run test:e2e`.

**Separazione netta: la logica non sa nulla di voce e DOM.**

```
src/
  core/        logica pura, testata a fondo
    turn/      schema della risposta (JSON schema + tipi), estrattore JSON incrementale, validazione, diff delle correzioni
    session/   macchina a stati (riposo, ascolta, pensa, parla, corregge, ripeti, errore), fasi e trigger di chiusura, ripresa, pianificatore giornaliero, matcher delle frasi di aiuto
    memory/    profilo (con "chi sei"), frasi, errori (chiave normalizzata), scenari, sessioni; registro eventi + riduttori; unione per id; compattazione
    srs/       scheduler FSRS, mappatura segnali → voti, regole di ritiro, soglie di sanità
    prompt/    system prompt stabile, scheda dello studente, micro-obiettivi iniziali, preset dei modelli
    cost/      token × listino versionato, budget
    pacing/    orologio stimato per l'animazione del parlato, calibrazione
    redact/    filtro dei segreti nei testi
  llm/         client Claude (SDK, streaming, usage, tabella degli errori, rifiuti, riscaldamento dello schema, convalida chiave); client finto per test
  voice/       interfacce SpeechInput/SpeechOutput; adattatori Web Speech (profili e mappa errori per piattaforma, bootstrap e risoluzione voci, una utterance alla volta con token di generazione e watchdog, sblocco iOS, half-duplex); adattatori testo; rilevatore di energia e cuffie (PC)
  storage/     IndexedDB, localStorage, export/import, adattatore di sync (GitHub Contents API)
  ui/          telaio (ordito, pettine, linea di battuta, stoffa, cimosa, rotolo, ritratto), trascritto, correzione, progresso, etichetta di composizione, stati vuoti/errore, modalità tasca, earcon
  platform/    rilevamento capacità (standalone, wake lock, Media Session, vibrazione, AEC di sistema), PWA, prova del telefono
tests/         unit (Vitest) e e2e (Playwright)
docs/          PIANO.md, ricerca/
.github/workflows/  check, e2e, deploy
```

**Modalità solo testo** come cittadino di prima classe: stessa macchina a stati, `TextInput`/`TextOutput`; serve all'utente quando non può parlare e a me per provare tutto senza audio.

**Qualità prima di ogni consegna.** `npm run check` verde; Playwright esegue un giro completo in modalità testo con API finta e salva screenshot degli stati principali e dei temi (chiaro, scuro, movimento ridotto), che vengono guardati; test che l'export e il payload di sync non contengano segreti e che `index.html` non abbia script inline. Niente si pubblica rosso.

---

## 4. Traguardi, in ordine

1. **Un giro completo.** Scaffolding, CI, deploy su Pages, CLAUDE.md. Impostazioni con chiave (salvata in locale, convalidata con `GET /v1/models`, avviso sull'origine condivisa) e scelta voci con provini. Tocco → ascolto → risposta strutturata in streaming → voce bilingue segmento per segmento, una utterance alla volta → riapertura del microfono. Telaio v1: ordito, pettine con etichetta grande, varco, trascritto grande, riga di Vera, stati Ascolta/Pensa/Parla/Riposo, tema chiaro e scuro, movimento ridotto, prova brutale con verdetto. Modalità solo testo. Aiuti locali ("ripeti", "più lento") a voce e a tocco. Etichetta di composizione con diagnostica copiabile e contatore di costo da `usage`. **Pagina "prova del telefono"** (ascolto in scheda e da schermata Home, voci, boundary sì/no, wake lock, bip) con etichetta copiabile, da provare il giorno 1 sul tuo telefono. Misura dei tempi e confronto dei tre preset di modello. Test del core e screenshot. **Risultato: apri la pagina, parli, ti capisce, ti risponde a voce nelle due lingue.**
2. **Memoria e sessioni.** Primo avvio con le domande a voce e "chi sei"; profilo; micro-obiettivi con livello e scenari; sessione in tre fasi guidate dall'app con chiusura "tre cose"; checkpoint e ripresa; pianificatore giornaliero; la stoffa che cresce e si salva (IndexedDB); cimosa; ritratto e vista "Progresso"; export/import; "non ho capito" e "come si dice" con ascolto in italiano.
3. **Correzioni e ripetizione.** Correzione strutturata → trasformazione della parola, riga fantasma, confronto in colonna, produzione guidata alla battuta successiva; FSRS per frasi ed errori; segnali → voti con registro e soglie di sanità; riscaldamento con gli elementi in scadenza; errori che spariscono; regola di fading dell'italiano; peso delle righe dallo stato FSRS.
4. **Telefono e sincronizzazione.** PWA installabile con aggiornamento solo a riposo, wake lock, profili Android e iOS con watchdog e mappa errori, prova dell'app installata su iPhone, "Oppure scrivi", stati offline; test `GET`/`PUT` reale dall'origine Pages e poi sync con repo privato; modalità tasca opzionale con earcon. **Ramificazione:** se il telefono è un iPhone e l'app installata non ascolta, l'adattatore "registrazione + riconoscimento cloud" sale qui dal traguardo 5 e la tabella della sezione 2 viene riscritta.
5. **Rifinitura.** Interruzione a voce dove sicura, `start(track)` e on-device su Chrome desktop, coreografia ridotta automatica, Media Session sperimentale, prove su dispositivi reali con la diagnostica incollata, e (se richiesto) adattatore TTS cloud.

Ogni traguardo finisce con build, tipi e test verdi, screenshot guardati, CLAUDE.md aggiornato e una nota su cosa funziona, cosa non ho potuto verificare e cosa resta da fare a mano.

---

## 5. Passi che restano all'utente

- Attivare GitHub Pages: Settings > Pages > Build and deployment > Source = **GitHub Actions** (una volta sola, prima del primo deploy); poi chiedermi la pull request verso `main` quando vuoi pubblicare, oppure autorizzare il branch di lavoro nell'ambiente `github-pages`.
- Non pubblicare altri siti GitHub Pages sullo stesso account (condividono l'origine e potrebbero leggere la chiave), o usare un dominio personalizzato.
- Creare una chiave API nella Console Anthropic (dedicata, con scadenza) e un limite di spesa mensile in Settings > Billing.
- Per la sincronizzazione (traguardo 4): creare un repository privato vuoto per i dati e un fine-grained token limitato a quel repo con `Contents: Read and write`.
- Provare la "prova del telefono" il giorno 1 e incollarmi l'etichetta; io non sento l'audio.
- Android: la voce di Vera è la voce predefinita del motore TTS del telefono; si cambia nelle impostazioni del telefono (Google Text-to-speech o equivalente).
- iPhone: Siri/Dettatura attiva; Safari > Impostazioni sito > Microfono = Consenti per evitare la richiesta a ogni apertura; iOS 18.4 o successivo per lo schermo acceso nell'app installata.

---

## 6. Domande aperte

1. **Telefono: iPhone o Android?** Cambia la priorità dell'adattatore "registrazione + riconoscimento cloud" (serve un'altra chiave) e cosa posso promettere sul tempo di risposta.
2. **Identità visiva:** va bene il telaio con gli innesti, oppure preferisci "Corpus" (il più vicino al tuo seed, ma con stati meno leggibili su telefono e un rendering su Canvas più rischioso)?
3. **Sincronizzazione:** d'accordo con il repo privato più token (5 minuti di setup), o per ora basta esporta/importa? Riguarda solo il traguardo 4.

Se non ci sono obiezioni, le ipotesi di lavoro sono: Sonnet 5.5 come modello predefinito (confermato dalle misure del traguardo 1), telaio come identità, repo privato per la sync.
