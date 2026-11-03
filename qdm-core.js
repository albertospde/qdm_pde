// QDM — logica condivisa di lettura degli Excel GfK e calcolo delle righe da salvare.
// Usata da index.html (pulsante "Elabora") e da scripts/gfk-import.mjs (import automatico
// del giovedì su GitHub Actions): stesso codice, stessi numeri.
// Richiede SheetJS in globalThis.XLSX (nel browser lo carica il <script> della CDN).
(function (root) {
  'use strict';

  const TIPI = ['gfk2026', 'gfk2025', 'top20week', 'top20tot', 'generiPDE', 'generiMercato'];

  // ── PARSER ─────────────────────────────────────────────────
  function parseGFK(buf) {
    const XLSX = root.XLSX;
    // Usa raw:true per mantenere i numeri come numeri (non stringhe)
    const wb = XLSX.read(buf, {type:'array'});
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:null, raw:true});

    // Estrai meta: scansiona le prime 20 righe per coppie chiave/valore
    const meta = {};
    for (let i = 0; i < 20; i++) {
      const r = raw[i];
      if (!r) continue;
      const nonNull = r.filter(v => v != null && String(v).trim() !== '');
      if (nonNull.length >= 2) {
        const k = String(nonNull[0]).trim();
        const v = String(nonNull[1]).trim();
        if (k && v && k !== 'Criteria:') meta[k] = v;
      }
    }

    // Trova riga header: prima riga con cella [0] = 'Rank' o 'ID'
    let headerRowIdx = -1;
    for (let i = 10; i < 25; i++) {
      const r = raw[i] || [];
      const first = r[0] != null ? String(r[0]).trim() : '';
      if (first === 'Rank' || first === 'ID') {
        headerRowIdx = i;
        break;
      }
    }
    if (headerRowIdx === -1) headerRowIdx = 16;

    const firstHeader = String((raw[headerRowIdx] || [])[0] || '').trim();
    const isGeneri = firstHeader === 'ID';

    // Costruisci headers: mantieni tutti i nomi, gestisci duplicati
    const rawHeaders = raw[headerRowIdx] || [];
    const headers = rawHeaders.map((h, i) =>
      h != null && String(h).trim() !== '' ? String(h).trim() : `_c${i}`
    );

    // Per i file Top20 che hanno due colonne 'Rank', 'Value', 'Units', 'Value %', 'Units %', 'Ø-Price'
    // le colonne della settimana vengono DOPO quelle "since release"
    // Strategia: per Top20, tieni traccia degli indici esatti per nome
    const colIndex = {}; // nome → [lista indici]
    headers.forEach((h, i) => {
      if (!colIndex[h]) colIndex[h] = [];
      colIndex[h].push(i);
    });

    const rows = [];
    for (let i = headerRowIdx + 1; i < raw.length; i++) {
      const r = raw[i];
      if (!r || r.every(v => v == null || String(v).trim() === '')) continue;
      const obj = {};
      headers.forEach((h, j) => {
        // Per duplicati, usa suffisso _2, _3...
        const occurrences = headers.slice(0, j).filter(x => x === h).length;
        const key = occurrences === 0 ? h : `${h}_${occurrences + 1}`;
        obj[key] = r[j] ?? null;
      });
      rows.push(obj);
    }

    return { meta, headers, colIndex, rows, isGeneri };
  }

  // ── DETECT TYPE ────────────────────────────────────────────
  function detectType({ meta, headers, isGeneri }) {
    const period     = meta['Period'] || '';
    const publisher  = meta['Publisher'] || '';
    const hasCompare = !!meta['Compare period'];
    const hasTitle   = headers.includes('Title');

    // 1. GENERI: header inizia con ID
    if (isGeneri || hasCompare) {
      return publisher === 'All' ? 'generiMercato' : 'generiPDE';
    }

    // 2. TOP 20: hanno colonna Title
    if (hasTitle) {
      // top20week = periodo singola settimana (no " - " nel period, es. "CW 22 2026")
      // top20tot  = periodo cumulativo (es. "CW 01 2026 - CW 22 2026")
      return period.includes(' - ') ? 'top20tot' : 'top20week';
    }

    // 3. GFK PUBLISHER: hanno Publisher, no Title
    if (headers.includes('Publisher')) {
      const years = [...new Set((period.match(/\d{4}/g) || []))];
      return years.every(y => y === '2025') ? 'gfk2025' : 'gfk2026';
    }

    return null;
  }

  function normalizeWeekKey(period) {
    const year = (period.match(/(\d{4})/) || [])[1] || '';
    const cws = [...period.matchAll(/CW\s*0*(\d+)/gi)].map(m => 'CW'+m[1].padStart(2,'0'));
    if (cws.length >= 2) return `${year}_${cws[0]}-${cws[cws.length-1]}`;
    return `${year}_${cws[0]||'CW?'}`;
  }

  // Editori del file GFK 2026 senza promozione nel DB (editore_promozione)
  function editoriNonMappati(rec, dbPromo) {
    const editori26 = [...new Set(
      rec.gfk2026.rows
        .filter(r => r['Publisher'] && String(r['Publisher']) !== 'Total' && String(r['Rank']).toLowerCase() !== 'total')
        .map(r => r['Publisher'])
    )];
    return editori26.filter(e => !dbPromo[e]);
  }

  // ── AGGREGAZIONI ───────────────────────────────────────────
  function aggPerPromo(rows26, rows25, quadratura, dbPromo) {
    const agg = {};
    const isTotal = r => {
      const pub = r['Publisher'];
      const rank = r['Rank'];
      if (pub == null) return true;
      if (String(pub).toLowerCase() === 'total') return true;
      if (rank != null && String(rank).toLowerCase() === 'total') return true;
      return false;
    };

    const set26 = new Set(rows26.filter(r=>!isTotal(r)).map(r=>r['Publisher']));
    const set25 = new Set(rows25.filter(r=>!isTotal(r)).map(r=>r['Publisher']));

    // PARITÀ:
    //   2026 → tutti gli editori 2026 (set26) → totale 566M
    //   2025 → solo gli editori 2026 che esistevano anche nel 2025 (intersezione)
    //   Confronto: stesso perimetro di editori, anni diversi
    //
    // QUADRATURA:
    //   2026 → tutti gli editori 2026 (set26)
    //   2025 → tutti gli editori 2025 (set25, perimetro nativo 2025)
    //   Confronto: ognuno col proprio perimetro nativo

    const filtro26 = set26; // 2026 sempre completo in entrambe le viste
    const filtro25 = quadratura ? set25 : new Set([...set26].filter(e=>set25.has(e)));

    rows26.filter(r=>!isTotal(r)&&filtro26.has(r['Publisher'])).forEach(r=>{
      const p = dbPromo[r['Publisher']] || 'ALTRO';
      if (!agg[p]) agg[p]={v26:0,u26:0,v25:0,u25:0};
      agg[p].v26 += Number(r['Value'])||0;
      agg[p].u26 += Number(r['Units'])||0;
    });
    rows25.filter(r=>!isTotal(r)&&filtro25.has(r['Publisher'])).forEach(r=>{
      const p = dbPromo[r['Publisher']] || 'ALTRO';
      if (!agg[p]) agg[p]={v26:0,u26:0,v25:0,u25:0};
      agg[p].v25 += Number(r['Value'])||0;
      agg[p].u25 += Number(r['Units'])||0;
    });
    return agg;
  }

  function parseGeneri(rows, tipo, weekKey) {
    // Struttura generi: ID, Genre, Value26, Value%26, Units26, Units%26, Ø-Price26,
    //                   Value25, Value%25, Units25, Units%25, Ø-Price25,
    //                   _, DeltaValue, _, DeltaUnits
    return rows
      .filter(r => {
        const id = String(r['ID'] ?? r['_c0'] ?? '').toLowerCase();
        const genre = r['Genre'] ?? r['_c1'];
        return genre && id !== 'total' && id !== 'id' && id !== '';
      })
      .map(r => {
        const ks = Object.keys(r);
        const n = k => Number(r[k]) || 0;
        return {
          week_key:     weekKey, tipo,
          genre_id:     String(r[ks[0]] || ''),
          genre:        String(r[ks[1]] || ''),
          value_26:     n(ks[2]),
          value_pct_26: n(ks[3]),
          units_26:     n(ks[4]),
          pm_26:        n(ks[6]),
          value_25:     n(ks[7]),
          value_pct_25: n(ks[8]),
          units_25:     n(ks[9]),
          pm_25:        n(ks[11]),
          delta_value:  n(ks[13]),
          delta_units:  n(ks[15]),
        };
      });
  }

  function parseTop20(rows, tipo, weekKey, dbPromo) {
    // Struttura Top20: ha colonne duplicate (Rank, Value, Units, Value %, Units %, Ø-Price)
    // Le colonne della settimana/periodo sono le SECONDE occorrenze (suffisso _2)
    // Le prime sono "since release" / cumulative
    // Colonne uniche: Title, Author, Publisher, ISBN/EAN, Cover price, Genre level 1, ecc.
    return rows
      .filter(r => {
        // Riga valida: il primo Rank è un numero
        const rk = r['Rank'];
        return rk != null && !isNaN(Number(rk)) && String(rk).toLowerCase() !== 'total';
      })
      .map(r => {
        // Value e Units della settimana: usa la seconda occorrenza se esiste, altrimenti la prima
        const value   = Number(r['Value_2']   ?? r['Value'])   || 0;
        const valuePct= Number(r['Value %_2'] ?? r['Value %']) || 0;
        const units   = Number(r['Units_2']   ?? r['Units'])   || 0;
        const unitsPct= Number(r['Units %_2'] ?? r['Units %']) || 0;
        const pm      = Number(r['Ø-Price_2'] ?? r['Ø-Price']) || 0;
        // Rank di mercato: seconda occorrenza se esiste
        const rankMkt = Number(r['Rank_2'] ?? r['Rank']) || 0;

        return {
          week_key: weekKey, tipo,
          rank_pos:   rankMkt,
          title:      r['Title']    || '',
          author:     r['Author']   || '',
          publisher:  r['Publisher']|| '',
          promozione: dbPromo[r['Publisher']] || 'ALTRO',
          ean:        String(r['ISBN / EAN'] || ''),
          cover_price:Number(r['Cover price'])|| 0,
          genre:      r['Genre level 1'] || r['Genre'] || '',
          value, value_pct: valuePct,
          units, units_pct: unitsPct,
          pm,
        };
      });
  }

  // ── SETTIMANA COMPLETA ─────────────────────────────────────
  // rec = { gfk2026, gfk2025, top20week, top20tot, generiPDE, generiMercato } (output di parseGFK)
  // Restituisce le righe per qdm_settimane, qdm_recap, qdm_trend, qdm_generi, qdm_top20.
  function calcolaSettimana(rec, dbPromo, adesso) {
    const period26 = rec.gfk2026.meta['Period'] || '';
    const weekKey = normalizeWeekKey(period26);
    const yearMatch = period26.match(/(\d{4})/);
    const anno = yearMatch ? parseInt(yearMatch[1]) : 2026;
    const cwNums = [...period26.matchAll(/CW\s*0*(\d+)/gi)].map(m=>parseInt(m[1]));
    const cwFrom = cwNums[0] || null;
    const cwTo = cwNums[cwNums.length-1] || null;

    const agg26p = aggPerPromo(rec.gfk2026.rows, rec.gfk2025.rows, false, dbPromo);
    const agg26q = aggPerPromo(rec.gfk2026.rows, rec.gfk2025.rows, true, dbPromo);

    const allPromo = new Set([...Object.keys(agg26p), ...Object.keys(agg26q)]);
    const totV26 = Object.values(agg26p).reduce((s,d)=>s+(d.v26||0),0);
    const totU26 = Object.values(agg26p).reduce((s,d)=>s+(d.u26||0),0);
    const totV25p = Object.values(agg26p).reduce((s,d)=>s+(d.v25||0),0);
    const totU25p = Object.values(agg26p).reduce((s,d)=>s+(d.u25||0),0);
    const totV25q = Object.values(agg26q).reduce((s,d)=>s+(d.v25||0),0);
    const totU25q = Object.values(agg26q).reduce((s,d)=>s+(d.u25||0),0);

    const recap = [...allPromo].map(p => {
      const dp = agg26p[p]||{}, dq = agg26q[p]||{};
      return {
        week_key:weekKey, promozione:p,
        value_26:dp.v26||0, units_26:dp.u26||0,
        pm_26: dp.u26 ? dp.v26/dp.u26 : 0,
        qdm_value_26: totV26 ? (dp.v26||0)/totV26 : 0,
        qdm_units_26: totU26 ? (dp.u26||0)/totU26 : 0,
        value_25p:dp.v25||0, units_25p:dp.u25||0,
        pm_25p: dp.u25 ? dp.v25/dp.u25 : 0,
        qdm_value_25p: totV25p ? (dp.v25||0)/totV25p : 0,
        qdm_units_25p: totU25p ? (dp.u25||0)/totU25p : 0,
        value_25q:dq.v25||0, units_25q:dq.u25||0,
        pm_25q: dq.u25 ? dq.v25/dq.u25 : 0,
        qdm_value_25q: totV25q ? (dq.v25||0)/totV25q : 0,
        qdm_units_25q: totU25q ? (dq.u25||0)/totU25q : 0,
      };
    });

    // Storico compatto: sopravvive alla pulizia delle settimane vecchie
    const updatedAt = (adesso || new Date()).toISOString();
    const trend = recap.map(r => ({
      week_key:weekKey, anno, cw_to:cwTo, promozione:r.promozione,
      value_26:r.value_26, units_26:r.units_26,
      value_25p:r.value_25p, units_25p:r.units_25p,
      value_25q:r.value_25q, units_25q:r.units_25q,
      updated_at:updatedAt,
    }));

    const generi = [
      ...parseGeneri(rec.generiPDE.rows, 'PDE', weekKey),
      ...parseGeneri(rec.generiMercato.rows, 'MERCATO', weekKey),
    ];
    const top20 = [
      ...parseTop20(rec.top20week.rows, 'WEEK', weekKey, dbPromo),
      ...parseTop20(rec.top20tot.rows, 'TOTALE', weekKey, dbPromo),
    ];

    return {
      weekKey,
      settimana: {week_key:weekKey, anno, cw_from:cwFrom, cw_to:cwTo},
      recap, trend, generi, top20,
    };
  }

  const QDMCore = { TIPI, parseGFK, detectType, normalizeWeekKey, editoriNonMappati, aggPerPromo, parseGeneri, parseTop20, calcolaSettimana };
  root.QDMCore = QDMCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = QDMCore;
})(typeof window !== 'undefined' ? window : globalThis);
