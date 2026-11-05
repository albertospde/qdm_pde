// QDM — import automatico settimanale dei dati GfK (Book Insights, https://bi.gfk-e.com).
// Eseguito da GitHub Actions (.github/workflows/gfk-import.yml) il giovedì dalle 8 (ora italiana).
//
//   1. chiede alla edge function qdm-gfk-import l'ultima settimana caricata e la mappa editore → promozione
//   2. se manca l'ultima settimana chiusa: entra nel portale GfK con un browser (Playwright),
//      apre i 6 report (stessi indirizzi che si usano a mano) e li scarica col pulsante EXCEL (10.000 righe)
//   3. li elabora con qdm-core.js: stesso identico calcolo del pulsante "Elabora" dell'app
//   4. salva le righe tramite la edge function, conserva gli Excel in storage (qdm-gfk/ultima/) e scrive l'esito
//      in qdm_import_log (editori senza promozione → ALTRO, segnalati in app)
//
// Variabili d'ambiente:
//   QDM_GFK_CRON_KEY  segreto GitHub = app_secrets.qdm_gfk_cron
//   GFK_USER, GFK_PASSWORD  credenziali del portale GfK (segreti GitHub)
//   SETTIMANA  facoltativa, es. "2026-43" (vuota = ultima settimana chiusa)
//   PROVA=1    scarica ed elabora ma NON salva: confronta con i dati già in QDM per quella settimana
//   FORZA=1    ignora orario e settimana già presente (riscrive la settimana)
// Nei log stampa solo conteggi: il repo è pubblico.

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { chromium } from "playwright";

globalThis.XLSX = XLSX;
const require = createRequire(import.meta.url);
const core = require("../qdm-core.js");

const FN_URL = "https://tdflwenlylhctxssatax.supabase.co/functions/v1/qdm-gfk-import";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkZmx3ZW5seWxoY3R4c3NhdGF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzgyNzYsImV4cCI6MjA5MTkxNDI3Nn0.l35qEL7LOvyYuI1McQlVqj4vbyTqmlevcmqWbTGYi2Q";
const GFK = "https://bi.gfk-e.com";
const APP = `${GFK}/bookint.it/#`;
const ORA_INIZIO = 8;   // ora italiana del primo tentativo del giovedì (se GfK non ha ancora pubblicato, riprova l'ora dopo)
const ORA_ULTIMO = 13;  // ultimo passaggio del giovedì: se i dati mancano ancora, lo scrive nel log
const BLOCCO = 2000;

const { QDM_GFK_CRON_KEY: CRON_KEY, GFK_USER, GFK_PASSWORD } = process.env;
const PROVA = process.env.PROVA === "1" || process.env.PROVA === "true";
const FORZA = process.env.FORZA === "1" || process.env.FORZA === "true";

// ── edge function ─────────────────────────────────────────────
async function fn(azione, dati = {}) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, "x-cron-key": CRON_KEY },
    body: JSON.stringify({ azione, ...dati }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${azione}: ${j.error || res.status}`);
  return j;
}

// ── settimane ISO (GfK usa le CW ISO, dal lunedì) ─────────────
const giorno = 86400000;
function lunediCW(anno, cw) {
  const g4 = new Date(Date.UTC(anno, 0, 4));             // il 4 gennaio è sempre nella CW 01
  const lun1 = g4.getTime() - ((g4.getUTCDay() + 6) % 7) * giorno;
  return new Date(lun1 + (cw - 1) * 7 * giorno);
}
function cwDi(data) {
  const d = new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), data.getUTCDate()));
  const gio = new Date(d.getTime() + (3 - ((d.getUTCDay() + 6) % 7)) * giorno);  // giovedì della stessa settimana
  const anno = gio.getUTCFullYear();
  return { anno, cw: Math.round((gio - lunediCW(anno, 1)) / (7 * giorno)) + 1 };
}
const settimaneNellAnno = anno => cwDi(new Date(Date.UTC(anno, 11, 28))).cw;
const iso = d => d.toISOString().slice(0, 10);
const due = n => String(n).padStart(2, "0");

function oggiRoma() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { data: new Date(Date.UTC(+p.year, +p.month - 1, +p.day)), ora: +p.hour };
}

function settimanaDaImportare() {
  if (process.env.SETTIMANA) {
    const m = process.env.SETTIMANA.trim().match(/^(\d{4})\D+(\d{1,2})$/);
    if (!m) throw new Error(`SETTIMANA non valida: "${process.env.SETTIMANA}" (formato 2026-43)`);
    return { anno: +m[1], cw: +m[2] };
  }
  // ultima settimana chiusa = quella prima della settimana corrente
  return cwDi(new Date(oggiRoma().data.getTime() - 7 * giorno));
}

function reportDaScaricare({ anno, cw }) {
  const cwPrec = Math.min(cw, settimaneNellAnno(anno - 1));
  const da = iso(lunediCW(anno, 1)), a = iso(lunediCW(anno, cw));
  const daPrec = iso(lunediCW(anno - 1, 1)), aPrec = iso(lunediCW(anno - 1, cwPrec));
  const editori = sl => `${APP}/publishers/publisher?c=1105&cu=EUR&pa=1&s=units:1,value:1,id:0&sl=${sl}`;
  const titoli = sl => `${APP}/products?c=1105&cu=EUR&pa=1&s=units:1,value:1,id:0&sl=${sl}`;
  const generi = pu => `${APP}/genres?c=1105&cu=EUR&g=LEVEL.1${pu ? `&pu=${pu}` : ""}&s=units:1,value:1&sl=${da}:w:${a},${daPrec}:w:${aPrec}`;
  return {
    weekKey: `${anno}_CW01-CW${due(cw)}`,
    gfk2026: editori(`${da}:w:${a}`),
    gfk2025: editori(`${daPrec}:w:${aPrec}`),
    top20week: titoli(`${a}:w:${a}`),
    top20tot: titoli(`${da}:w:${a}`),
    generiMercato: generi(null),
    generiPDE: generi,   // funzione: serve l'elenco editori del filtro salvato "PDE PERIMETRO <anno>"
  };
}

// ── portale GfK ───────────────────────────────────────────────
const RANKING = /biapi\.gfk-e\.com\/v\d\/bookint\.it\/(publisher|genre|product)\/ranking/;
let FASE = "avvio";      // passo in corso, finisce nel log se qualcosa va storto
let DIAGNOSI = null;     // indirizzo e testo della pagina al momento dell'errore (solo nel log privato)

async function diagnosi(page) {
  try {
    const testo = await page.locator("body").innerText({ timeout: 5000 });
    return { url: page.url().slice(0, 300), titolo: await page.title(), testo: testo.replace(/\s+/g, " ").slice(0, 800) };
  } catch { return { url: page.url().slice(0, 300) }; }
}

async function entra(page) {
  await page.goto(`${GFK}/signin`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="username"]', GFK_USER);
  await page.fill('input[name="password"]', GFK_PASSWORD);
  await Promise.all([
    page.waitForURL(/\/bookint\.it\//, { timeout: 60000 }).catch(() => {}),
    page.locator('form.sign__form [type="submit"], form.sign__form button').first().click(),
  ]);
  if (!/\/bookint\.it\//.test(page.url())) throw new Error("Login GfK non riuscito: controllare GFK_USER / GFK_PASSWORD");
  // aspetta che l'app del portale sia pronta (pagina iniziale con la cronologia)
  await page.getByText(/recently visited pages/i).first().waitFor({ state: "visible", timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

// Apre un report e aspetta i dati che la pagina stessa chiede al portale
async function apri(page, url) {
  const hash = "#" + url.split("#")[1];
  let r = null;
  for (let tentativo = 1; tentativo <= 2 && !r; tentativo++) {
    const risposta = page.waitForResponse(x => RANKING.test(x.url()), { timeout: 90000 }).catch(() => null);
    if (tentativo === 1) await page.evaluate(h => { window.location.hash = h; }, hash);   // come cliccare un link nel portale
    else { await page.goto(url, { waitUntil: "load" }); await page.reload({ waitUntil: "load" }); }
    r = await risposta;
  }
  if (!r) throw new Error("Il portale GfK non ha caricato il report");
  if (!r.ok()) throw new Error(`Report GfK non disponibile (${r.status()})`);
  const json = await r.json().catch(() => null);
  // la pagina mostra o il pulsante EXCEL (ci sono dati) o "This query returns no result"
  const atteso = (loc, valore) => loc.first().waitFor({ state: "visible", timeout: 60000 }).then(() => valore, () => null);
  const esito = await Promise.race([
    atteso(page.locator(".export--excel button"), "dati"),
    atteso(page.getByText(/this query returns no result/i), "vuoto"),
  ]) ?? null;
  if (!esito) throw new Error("La pagina del report non mostra né i dati né il pulsante EXCEL");
  return { json, vuoto: esito === "vuoto" || righeDati(json) === 0 };
}

// Pulsante EXCEL → finestra "numero risultati" → 10.000 → conferma → file scaricato
async function esporta(page) {
  const scaricamento = page.waitForEvent("download", { timeout: 300000 });
  await page.locator(".export--excel button").first().click();
  const finestra = page.locator(".selection__overlay").first();
  const conFinestra = await finestra.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
  if (conFinestra) {
    await finestra.locator(".button-bar button").filter({ hasText: /^\s*10[.,\s]?000\s*$/ }).first().click();
    await finestra.locator(".selection__buttonbar--right button").first().click();
  }
  const d = await scaricamento;
  const percorso = await d.path();
  return new Uint8Array(await readFile(percorso));
}

// Elenco editori del filtro salvato "PDE PERIMETRO <anno>" (se manca: l'ultimo "PDE PERIMETRO" disponibile)
async function editoriPDE(page, urlGeneri, anno) {
  await apri(page, urlGeneri);
  await page.getByText(/saved filter presets/i).first().click();
  const voci = page.locator("li, a, div").filter({ hasText: /^\s*PDE PERIMETRO \d{4}\s*$/i });
  await voci.first().waitFor({ state: "visible", timeout: 30000 });
  const nomi = (await voci.allInnerTexts()).map(t => t.trim().toUpperCase());
  const anni = [...new Set(nomi.map(n => +n.match(/\d{4}/)[0]))].sort((x, y) => y - x);
  const scelto = anni.includes(anno) ? anno : anni[0];
  const risposta = page.waitForResponse(r => RANKING.test(r.url()), { timeout: 120000 });
  await voci.filter({ hasText: new RegExp(`PDE PERIMETRO ${scelto}`, "i") }).last().click();
  await risposta;
  const pu = new URL(page.url().replace("/#/", "/")).searchParams.get("pu");
  if (!pu) throw new Error(`Il filtro salvato "PDE PERIMETRO ${scelto}" non ha editori`);
  return { pu, preset: `PDE PERIMETRO ${scelto}`, nEditori: pu.split(",").length };
}

function righeDati(json) {
  const d = json?.data?.mainPeriod?.data ?? json?.data?.data ?? json?.data;
  return Array.isArray(d) ? d.length : null;
}

async function scaricaTutto(target) {
  const r = reportDaScaricare(target);
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, locale: "en-US", timezoneId: "Europe/Rome", viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const files = {};
  let filtro = null;
  try {
    FASE = "login GfK";
    await entra(page);

    // Dati della settimana già pubblicati? Lo dice la top titoli della SOLA settimana: i report
    // progressivi (CW01–CWnn) rispondono anche quando la CWnn non è ancora uscita, con i dati fino alla CWnn-1
    FASE = "report top20week";
    if ((await apri(page, r.top20week)).vuoto) return { disponibili: false };
    FASE = "export top20week";
    files.top20week = await esporta(page);

    for (const tipo of ["gfk2026", "gfk2025", "top20tot", "generiMercato"]) {
      FASE = `report ${tipo}`;
      if ((await apri(page, r[tipo])).vuoto) throw new Error(`Il report ${tipo} non ha dati`);
      FASE = `export ${tipo}`;
      files[tipo] = await esporta(page);
    }
    FASE = "filtro PDE PERIMETRO";
    filtro = await editoriPDE(page, r.generiMercato, target.anno);
    FASE = "report generiPDE";
    if ((await apri(page, r.generiPDE(filtro.pu))).vuoto) throw new Error("Il report generiPDE non ha dati");
    FASE = "export generiPDE";
    files.generiPDE = await esporta(page);
    return { disponibili: true, files, filtro };
  } catch (e) {
    DIAGNOSI = await diagnosi(page);
    throw e;
  } finally {
    await page.goto(`${GFK}/bookint.it/signout`).catch(() => {});   // libera la sessione GfK
    await browser.close();
  }
}

// ── controlli sui file ────────────────────────────────────────
function leggiEControlla(files, target) {
  const rec = {};
  const cwAtteso = `CW ${due(target.cw)} ${target.anno}`;
  const cwAttesoPrec = `CW ${due(Math.min(target.cw, settimaneNellAnno(target.anno - 1)))} ${target.anno - 1}`;
  const famiglia = t => t.startsWith("gfk") ? "gfk" : t.startsWith("top20") ? "top20" : t;
  for (const tipo of core.TIPI) {
    const p = core.parseGFK(files[tipo]);
    const rilevato = core.detectType(p);
    // gfk2026/gfk2025 e top20week/top20tot si distinguono qui dal periodo, non dal riconoscimento
    // dell'app (che per i GFK guarda l'anno 2025 e alla CW 01 confonde le due top 20)
    if (famiglia(rilevato || "") !== famiglia(tipo)) throw new Error(`File ${tipo}: riconosciuto come ${rilevato}`);
    if (!p.rows.length) throw new Error(`File ${tipo}: nessuna riga`);
    const periodo = p.meta["Period"] || "";
    const atteso = tipo === "gfk2025" ? cwAttesoPrec : cwAtteso;
    if (!periodo.endsWith(atteso)) throw new Error(`File ${tipo}: periodo "${periodo}" invece di ...${atteso}`);
    if (tipo === "top20week" && periodo.includes(" - ")) throw new Error(`File top20week: periodo "${periodo}" non settimanale`);
    if (tipo === "top20tot" && target.cw > 1 && !periodo.includes(" - ")) throw new Error(`File top20tot: periodo "${periodo}" non progressivo`);
    rec[tipo] = p;
  }
  return rec;
}

// ── prova: confronto con i dati già in QDM ───────────────────
async function leggiDB(weekKey, tabella) {
  const righe = [];
  for (let offset = 0; ; offset += 5000) {
    const r = await fn("leggi", { week_key: weekKey, tabella, offset });
    righe.push(...r.righe);
    if (r.fine) break;
  }
  return righe;
}

function confronta(nome, nuove, db, chiave) {
  const campi = Object.keys(nuove[0] || {}).filter(k => !["week_key", "updated_at"].includes(k));
  const mappa = new Map(db.map(r => [chiave(r), r]));
  let diverse = 0, mancanti = 0, maxRel = 0;
  const esempi = [];   // solo nel log privato (qdm_import_log), non nei log pubblici di GitHub
  for (const n of nuove) {
    const d = mappa.get(chiave(n));
    if (!d) { mancanti++; continue; }
    let diff = false;
    for (const c of campi) {
      let questo = false;
      if (typeof n[c] === "number") {
        const rel = Math.abs(n[c] - Number(d[c])) / Math.max(1, Math.abs(Number(d[c])));
        maxRel = Math.max(maxRel, rel);
        questo = rel > 1e-9;
      } else questo = String(n[c] ?? "") !== String(d[c] ?? "");
      if (questo) {
        diff = true;
        if (esempi.length < 12) esempi.push({ chiave: chiave(n), campo: c, nuovo: n[c], qdm: d[c] });
      }
    }
    if (diff) diverse++;
  }
  return { tabella: nome, nuove: nuove.length, db: db.length, mancanti, diverse, maxRel, esempi };
}

async function prova(calc) {
  const wk = calc.weekKey;
  const esiti = [
    confronta("qdm_recap", calc.recap, await leggiDB(wk, "qdm_recap"), r => r.promozione),
    confronta("qdm_trend", calc.trend, await leggiDB(wk, "qdm_trend"), r => r.promozione),
    confronta("qdm_generi", calc.generi, await leggiDB(wk, "qdm_generi"), r => `${r.tipo}|${r.genre_id}`),
    confronta("qdm_top20", calc.top20, await leggiDB(wk, "qdm_top20"), r => `${r.tipo}|${r.rank_pos}|${r.ean}`),
  ];
  return esiti;
}

// ── salvataggio ───────────────────────────────────────────────
async function salvaExcel(files, cartella) {
  for (const tipo of core.TIPI) {
    const { url } = await fn("upload_url", { tipo, cartella });
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-upsert": "true" },
      body: files[tipo],
    });
    if (!res.ok) throw new Error(`Salvataggio Excel ${tipo}: ${res.status}`);
  }
}

async function salva(calc, files) {
  await salvaExcel(files, "ultima");
  const wk = calc.weekKey;
  await fn("pulisci", { week_key: wk });
  for (const [tabella, righe] of [["qdm_recap", calc.recap], ["qdm_trend", calc.trend], ["qdm_generi", calc.generi], ["qdm_top20", calc.top20]]) {
    for (let i = 0; i < righe.length; i += BLOCCO) await fn("scrivi", { week_key: wk, tabella, righe: righe.slice(i, i + BLOCCO) });
  }
}

// ── main ──────────────────────────────────────────────────────
async function main() {
  if (!CRON_KEY) throw new Error("Manca il segreto QDM_GFK_CRON_KEY");
  if (!GFK_USER || !GFK_PASSWORD) throw new Error("Mancano i segreti GFK_USER / GFK_PASSWORD");

  const { ora } = oggiRoma();
  const target = settimanaDaImportare();
  const weekKey = `${target.anno}_CW01-CW${due(target.cw)}`;
  console.log(`Settimana: ${weekKey}${PROVA ? " (prova)" : ""}${FORZA ? " (forzata)" : ""}`);

  if (!PROVA && !FORZA && !process.env.SETTIMANA && ora < ORA_INIZIO) { console.log(`Sono le ${ora}: l'import parte dalle ${ORA_INIZIO}.`); return; }

  const stato = await fn("stato");
  if (!PROVA && !FORZA && stato.settimane.includes(weekKey)) { console.log("Settimana già presente in QDM: niente da fare."); return; }
  console.log(`Ultima in QDM: ${stato.ultima?.week_key ?? "nessuna"} · editori mappati: ${Object.keys(stato.promo).length}`);

  const t0 = Date.now();
  const scarico = await scaricaTutto(target);
  if (!scarico.disponibili) {
    console.log("GfK non ha ancora pubblicato i dati della settimana.");
    if (ora >= ORA_ULTIMO || FORZA || PROVA) await fn("log", { stato: "nessun_dato", week_key: weekKey, messaggio: `GfK non ha ancora pubblicato la CW${due(target.cw)} ${target.anno} (esce il giovedì mattina)` });
    return;
  }
  const dimensioni = Object.fromEntries(Object.entries(scarico.files).map(([k, v]) => [k, v.length]));
  console.log("Excel scaricati (byte):", JSON.stringify(dimensioni), `· filtro ${scarico.filtro.preset}: ${scarico.filtro.nEditori} editori`);

  FASE = "lettura Excel";
  const rec = leggiEControlla(scarico.files, target);
  const calc = core.calcolaSettimana(rec, stato.promo);
  if (calc.weekKey !== weekKey) throw new Error(`Settimana dei file ${calc.weekKey} invece di ${weekKey}`);
  const nonMappati = core.editoriNonMappati(rec, stato.promo);
  const righe = { recap: calc.recap.length, trend: calc.trend.length, generi: calc.generi.length, top20: calc.top20.length };
  console.log("Righe calcolate:", JSON.stringify(righe), `· editori senza promozione: ${nonMappati.length}`);
  // riga "Total" di ogni Excel e data di creazione: servono a capire se GfK ha ritoccato i dati
  const totali = Object.fromEntries(core.TIPI.map(t => {
    const tot = rec[t].rows.find(r => String(r["Rank"] ?? r["ID"] ?? "").toLowerCase() === "total");
    return [t, { periodo: rec[t].meta["Period"], righe: rec[t].rows.length, totale: tot ? Object.values(tot).filter(v => typeof v === "number").slice(0, 4) : null }];
  }));
  const dettagli = { righe, totali, file_byte: dimensioni, filtro_pde: scarico.filtro.preset, editori_filtro_pde: scarico.filtro.nEditori, secondi: Math.round((Date.now() - t0) / 1000) };

  if (PROVA) {
    await salvaExcel(scarico.files, "prova");   // per poterli confrontare a mano con quelli caricati in QDM
    const esiti = await prova(calc);
    esiti.forEach(e => console.log(`Confronto ${e.tabella}: ${e.nuove} nuove / ${e.db} in QDM · mancanti ${e.mancanti} · diverse ${e.diverse} · scarto max ${e.maxRel.toExponential(1)}`));
    const uguale = esiti.every(e => e.nuove === e.db && !e.mancanti && !e.diverse);
    await fn("log", { stato: "prova", week_key: weekKey, messaggio: uguale ? "Prova: dati identici a quelli in QDM" : "Prova: ci sono differenze", editori_non_mappati: nonMappati, dettagli: { ...dettagli, confronto: esiti } });
    console.log(uguale ? "PROVA OK: identico ai dati in QDM." : "PROVA: differenze trovate (vedi qdm_import_log).");
    return;
  }

  FASE = "salvataggio";
  await salva(calc, scarico.files);
  await fn("chiudi", {
    settimana: calc.settimana,
    log: {
      stato: "ok",
      messaggio: nonMappati.length ? `Importata; ${nonMappati.length} editori senza promozione messi in ALTRO` : "Importata",
      editori_non_mappati: nonMappati,
      dettagli,
    },
  });
  console.log(`Settimana ${weekKey} salvata in QDM.`);
}

main().catch(async e => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`ERRORE (${FASE}):`, msg);
  try { if (CRON_KEY) await fn("log", { stato: "errore", week_key: null, messaggio: `${FASE}: ${msg}`.slice(0, 500), dettagli: { fase: FASE, pagina: DIAGNOSI } }); } catch { /* ignora */ }
  process.exit(1);
});
