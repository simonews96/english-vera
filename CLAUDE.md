# CLAUDE.md — Vera, tutor vocale di inglese

Questo file è la memoria del progetto tra una sessione e l'altra. Ogni sessione riparte da zero: leggilo per intero prima di fare qualsiasi cosa, e aggiornalo prima di chiudere (sezione "Stato" e "Registro delle decisioni").

## Cos'è Vera

Un tutor vocale di inglese personale per un utente italiano principiante assoluto, obiettivo: cavarsela a voce in viaggio in 6 mesi con ~45 minuti al giorno in sessioni da 5-10 minuti, da PC (Chrome/Edge) e da telefono con auricolari. App statica su GitHub Pages, installabile (PWA), senza server: il cervello è l'API di Claude chiamata dal browser con la chiave dell'utente (salvata solo sul dispositivo); la voce usa le API del browser dietro un'interfaccia sostituibile. L'identità visiva è "Vera al telaio": il corpo di Vera è una stoffa fatta delle frasi inglesi che l'utente ha detto correttamente.

Il piano completo, con le alternative scartate, è in `docs/PIANO.md`. Gli appunti di ricerca con fonti e livelli di confidenza sono in `docs/ricerca/` (leggere la sezione "Critical claims + verdicts" prima di decidere su un punto tecnico).

## Stato del progetto

- **2026-10-02** — Piano scritto e presentato all'utente. **In attesa del suo ok.** Nessun codice applicativo scritto. Domande aperte: telefono (iPhone o Android), identità visiva (telaio proposto), modalità di sync (repo privato proposto).
- Prossimo passo dopo l'ok: traguardo 1 ("un giro completo"), vedi `docs/PIANO.md` §4.

## Come lavorare qui

- **Lingua.** Rispondere sempre in italiano all'utente. Codice, identificatori e commenti in inglese; testi dell'interfaccia in italiano (con le parti inglesi dove sono contenuto didattico).
- **Branch.** Sviluppo su `claude/vera-english-tutor-0psgm6`; commit con messaggi chiari; push con `git push -u origin <branch>`. Mai pull request senza richiesta esplicita.
- **Separazione.** La logica (turni, memoria, ripetizione, parsing della risposta strutturata, costi, pacing) vive in `src/core/` senza DOM e senza voce, ed è coperta da test Vitest. La voce sta dietro `SpeechInput`/`SpeechOutput` in `src/voice/`. Esiste sempre una modalità solo testo.
- **Prima di consegnare.** `npm run check` (typecheck + lint + test + build) verde; Playwright con il Chromium headless locale fa un giro completo in modalità testo con API finta e salva screenshot (chiaro, scuro, movimento ridotto) che vanno guardati. Non si pubblica nulla di rosso.
- **Fine sessione.** Aggiornare questo file (stato, decisioni, cosa funziona, cosa non è stato verificato, cosa resta all'utente) e dirlo all'utente nel messaggio finale.
- **Verifica, non memoria.** Per l'API di Claude seguire la documentazione ufficiale (modelli, parametri); per i browser, i comportamenti verificati in `docs/ricerca/`. Niente date nei model ID.
- **Sicurezza.** La chiave API e il token GitHub stanno solo nel browser dell'utente. Mai nel repository, mai in log, mai in URL. Nessuno script di terze parti nella pagina; CSP con `connect-src` limitato ad `api.anthropic.com` e `api.github.com`.

## Convenzioni tecniche (decise, da rispettare quando si scrive codice)

- Vite 8 + TypeScript 7 strict, senza framework UI (macchina a stati esplicita, `data-state` sulla radice, CSS derivato). Vitest 5, Playwright 1.63, vite-plugin-pwa 1.3, `@anthropic-ai/sdk` 0.131, `ts-fsrs` 5.x. Nessun'altra dipendenza di runtime senza motivo scritto qui.
- Claude: SDK con `dangerouslyAllowBrowser: true`; modello predefinito `claude-sonnet-5-5` con `thinking: { type: "between_tools" }` (senza tool = nessun ragionamento preliminare); alternative `claude-haiku-4-5` e `claude-opus-5-5`; streaming sempre; structured outputs via `output_config.format` (schema con `additionalProperties: false`, `segments` per primo, nessun campo chiamato `reasoning`/`thinking`); prompt caching sul system prompt; usage reale per il contatore di costo; gestione di `refusal`, 401, 429, 5xx, timeout, `max_tokens`. Mai `temperature`, prefill o `tool_choice` forzato su Sonnet 5.5.
- Voce: half-duplex rigoroso (riconoscimento fermo mentre Vera parla; riapertura solo dal punto "voce finita" alimentato da `end` **o** `error`, mai solo da `end`, perché `cancel()` non produce `end`); nuovo oggetto `SpeechRecognition` a ogni cambio lingua; una voce per lingua, segmenti spezzati per frase; sblocco di iOS con uno `speak()` sincrono nel primo tocco; nessun secondo flusso microfono su Android durante il riconoscimento; interruzione a voce solo con cuffie o AEC di sistema.
- Animazione del parlato: `onboundary` quando c'è, altrimenti orologio stimato con calibrazione per voce; la diagnostica dice quale.
- Dati: IndexedDB con registro eventi append-only + snapshot; export/import JSON; sync con repo privato GitHub via Contents API (sha per la concorrenza, GET condizionale, PUT ≤ 1 ogni 10 s).
- Pages: `base: '/english-vera/'`, nessun routing per percorso; deploy via Actions (`configure-pages`, `upload-pages-artifact`, `deploy-pages`).
- Design: token su `:root`, tema scuro sotto `prefers-color-scheme` e `[data-theme]`, `body` con sfondo esplicito; solo `transform`/`opacity` in animazione; `prefers-reduced-motion` rispettato con stati distinguibili dalla sola geometria; il colore di correzione compare solo per errori linguistici, mai per errori di sistema; etichetta di stato ≥ 20 px su telefono.

## Registro delle decisioni

| Data | Decisione | Perché | Alternativa scartata |
|---|---|---|---|
| 2026-10-02 | API di Claude chiamata dal browser (CORS + `dangerouslyAllowBrowser`) | Verificato con test live; nessun server da gestire | Proxy/backend; API vocali realtime di altri fornitori |
| 2026-10-02 | Modello predefinito Sonnet 5.5 con thinking spento, Haiku 4.5 e Opus 5.5 selezionabili | Equilibrio velocità/qualità; thinking spento = prima parola più rapida | Opus come default (thinking non spegnibile); Haiku come default (insegnante più debole, ritiro incerto) |
| 2026-10-02 | Structured outputs in streaming con estrattore JSON incrementale | Lingua per segmento, TTS al primo segmento chiuso | JSON chiesto nel prompt |
| 2026-10-02 | Web Speech API dietro `SpeechInput`/`SpeechOutput` | Costo zero; sostituibile con TTS/STT cloud | Dipendenza diretta dalle API del browser |
| 2026-10-02 | Half-duplex rigoroso; barge-in a tocco sempre, a voce solo con cuffie/AEC di sistema | La sintesi è fuori dalla pipeline audio del browser: l'AEC non la cancella | Full-duplex; VAD neurale (13 MB, instabile su iPhone) |
| 2026-10-02 | FSRS-6 (`ts-fsrs`) per frasi ed errori, con mappatura segnali → voti | Meglio calibrato di SM-2/Leitner anche con parametri di default | SM-2, Leitner; flashcard esplicite |
| 2026-10-02 | Sync con repo privato GitHub + fine-grained token; export/import sempre | Zero server, CORS verificato, concorrenza via sha, raggio d'azione limitato | Gist (URL-pubblici, nessuna concorrenza), Drive (OAuth client), Dropbox, WebDAV |
| 2026-10-02 | Identità "Vera al telaio" con innesti da Corpus/Partenze/La Forma | Stati leggibili da fermi, economico a 60 fps, fading dell'italiano strutturale | Corpus (stati deboli su telefono, Canvas rischioso), Partenze (split-flap cliché, timbro rosso), La Forma (skeuomorfo) |
| 2026-10-02 | Vanilla TypeScript, nessun framework UI | Rendering custom (Canvas + DOM) e macchina a stati esplicita; bundle piccolo | React/Svelte/Preact (possibile per i pannelli, da motivare) |

## Cosa funziona / cosa non è verificato (aggiornare a ogni sessione)

- Funziona: niente ancora (solo documenti).
- Non verificabile da questa macchina: audio reale, comportamento su telefoni veri, voci disponibili sui dispositivi dell'utente, ascolto nell'app installata su iPhone.
- Resta all'utente: attivare GitHub Pages (Source = GitHub Actions), creare la chiave API con limite di spesa, (traguardo 4) repo privato + token per la sync.
