# Vera

Tutor vocale di inglese personale: un'app statica, installabile, senza server. Si apre, si parla, Vera ascolta, risponde a voce in italiano e in inglese, corregge e ricorda. Il cervello è l'API di Claude, chiamata dal browser con la chiave dell'utente, che resta solo sul suo dispositivo.

- Piano, decisioni e limiti per piattaforma: `docs/PIANO.md`
- Memoria di progetto per le sessioni di lavoro: `CLAUDE.md`
- Appunti di ricerca verificati: `docs/ricerca/`

## Sviluppo

```sh
npm install
npm run dev        # sviluppo locale
npm run check      # tipi, lint, test unitari, build
npm run test:e2e   # giro completo nel browser (Chromium headless)
```

Pubblicazione: GitHub Pages tramite GitHub Actions (`.github/workflows/deploy.yml`). Prerequisito manuale: Settings > Pages > Source = "GitHub Actions".
