# Import automatico GfK → QDM

Ogni giovedì dalle 8 (ora italiana) GitHub Actions scarica dal portale **GfK Book Insights**
(https://bi.gfk-e.com) i 6 report della settimana chiusa e li carica in QDM. Il caricamento manuale dei file
non esiste più: in QDM c'è solo il pulsante **⟳ Aggiorna da GfK**, che avvia lo stesso job per la settimana
scelta (es. se GfK ha corretto i dati) tramite la funzione SQL `qdm_gfk_avvia` (token GitHub
`app_secrets.github_giro_manager_token`, condiviso con Giro Manager per scelta di Alberto).

| Pezzo | Dove |
|---|---|
| Orario e avvio manuale | `.github/workflows/gfk-import.yml` (giovedì 6:02–12:02 UTC, ogni ora; riprova finché GfK non pubblica) |
| Scaricamento ed elaborazione | `scripts/gfk-import.mjs` (Playwright + SheetJS) |
| Calcolo (identico al pulsante "Elabora") | `qdm-core.js`, usato anche da `index.html` |
| Scrittura nel database | edge function `qdm-gfk-import` (sorgente in `functions/`) |
| Tabella esiti, bucket, chiave | `sql/01_qdm_import_automatico_gfk.sql` |
| Pulsante "Aggiorna da GfK" | `sql/02_qdm_gfk_avvia.sql` |

I 6 report sono gli stessi indirizzi del portale usati a mano (`c=1105` Italia, `cu=EUR`), con le date
della settimana: editori anno corrente e anno prima, generi mercato, generi PDE (editori del filtro
salvato **"PDE PERIMETRO &lt;anno&gt;"**), top titoli della settimana e progressiva. Export EXCEL a 10.000 righe.

## Segreti GitHub (Settings → Secrets and variables → Actions)
- `QDM_GFK_CRON_KEY` = valore di `app_secrets.qdm_gfk_cron` su Supabase
- `GFK_USER`, `GFK_PASSWORD` = credenziali del portale GfK

## Avvio manuale (Actions → Import automatico GfK → Run workflow)
- **settimana**: es. `2026-43` (vuoto = ultima settimana chiusa)
- **prova**: scarica ed elabora ma non salva; confronta con i dati già in QDM e scrive l'esito in `qdm_import_log`
- **forza**: reimporta anche se la settimana è già presente

## Cosa succede dopo
- Esiti in `qdm_import_log` (`ok`, `prova`, `nessun_dato`, `errore`); nei log GitHub solo conteggi (repo pubblico).
- Editori senza promozione → contati in ALTRO; in QDM compare la barra "Assegna promozioni e ricalcola", che
  riprende gli Excel salvati in storage `qdm-gfk/ultima/` e riapre il solito popup.
- GfK permette una sola sessione per utente: il job esce dal portale alla fine, ma se in quel momento qualcuno
  è collegato con lo stesso account, il portale può disconnetterlo.
- GitHub sospende i cron dei repo senza commit da 60 giorni: in quel caso riattivarlo da Actions.
