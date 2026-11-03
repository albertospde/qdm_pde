# Import automatico GfK → QDM

Ogni giovedì dalle 9 (ora italiana) GitHub Actions scarica dal portale **GfK Book Insights**
(https://bi.gfk-e.com) i 6 report della settimana chiusa e li carica in QDM, come si faceva a mano
con "Carica file GFK" + "Elabora".

| Pezzo | Dove |
|---|---|
| Orario e avvio manuale | `.github/workflows/gfk-import.yml` (giovedì 7:15–12:15 UTC, ogni ora) |
| Scaricamento ed elaborazione | `scripts/gfk-import.mjs` (Playwright + SheetJS) |
| Calcolo (identico al pulsante "Elabora") | `qdm-core.js`, usato anche da `index.html` |
| Scrittura nel database | edge function `qdm-gfk-import` (sorgente in `functions/`) |
| Tabella esiti, bucket, chiave | `sql/01_qdm_import_automatico_gfk.sql` |

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
