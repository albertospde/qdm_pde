// QDM — tramite tra l'import automatico GfK (GitHub Actions: scripts/gfk-import.mjs) e il database.
// Il job scarica ed elabora i 6 Excel GfK; questa funzione scrive soltanto, con i permessi di servizio.
// POST con header x-cron-key (= app_secrets.qdm_gfk_cron), body { azione, ... }:
//   stato       → ultima settimana caricata, elenco settimane, mappa editore → promozione
//   upload_url  → { tipo } → URL firmato per salvare l'Excel in storage qdm-gfk/ultima/<tipo>.xlsx
//   leggi       → { week_key, tabella, offset } → righe già salvate (per la prova di confronto)
//   pulisci     → { week_key } → cancella recap/trend/generi/top20 di quella settimana
//   scrivi      → { week_key, tabella, righe } → inserisce righe di quella settimana
//   chiudi      → { settimana, log } → registra la settimana, pulisce il dettaglio delle settimane vecchie, scrive il log
//   log         → { stato, week_key?, messaggio?, editori_non_mappati?, dettagli? } → riga in qdm_import_log
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = "https://tdflwenlylhctxssatax.supabase.co";
const TABELLE = ["qdm_recap", "qdm_trend", "qdm_generi", "qdm_top20"];
const TIPI = ["gfk2026", "gfk2025", "top20week", "top20tot", "generiPDE", "generiMercato"];
const BLOCCO_LETTURA = 5000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

function adminClient() {
  return createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

const WEEK_KEY = /^\d{4}_CW\d{2}(-CW\d{2})?$/;
function weekKey(v: unknown) {
  const k = String(v ?? "");
  if (!WEEK_KEY.test(k)) throw new Error("week_key non valido");
  return k;
}

async function scriviLog(admin: ReturnType<typeof adminClient>, l: Record<string, unknown>) {
  const riga = {
    origine: "github",
    stato: String(l.stato ?? "errore"),
    week_key: l.week_key ?? null,
    messaggio: l.messaggio ?? null,
    editori_non_mappati: l.editori_non_mappati ?? null,
    dettagli: l.dettagli ?? null,
  };
  const { error } = await admin.from("qdm_import_log").insert(riga);
  if (error) throw new Error("Errore log: " + error.message);
}

// deno-lint-ignore no-explicit-any
async function azione(body: any) {
  const admin = adminClient();
  switch (body.azione) {
    case "stato": {
      const { data: sett, error } = await admin.from("qdm_settimane").select("week_key, anno, cw_from, cw_to")
        .order("anno", { ascending: false }).order("cw_to", { ascending: false });
      if (error) throw new Error("Errore settimane: " + error.message);
      const promo: Record<string, string> = {};
      for (let da = 0; ; da += 1000) {
        const { data, error: e } = await admin.from("editore_promozione").select("editore_gfk, promo_2026").range(da, da + 999);
        if (e) throw new Error("Errore editore_promozione: " + e.message);
        (data || []).forEach(r => { promo[r.editore_gfk] = r.promo_2026; });
        if (!data || data.length < 1000) break;
      }
      return { ultima: sett?.[0] ?? null, settimane: (sett || []).map(s => s.week_key), promo };
    }
    case "upload_url": {
      if (!TIPI.includes(body.tipo)) throw new Error("tipo non valido");
      const { data, error } = await admin.storage.from("qdm-gfk").createSignedUploadUrl(`ultima/${body.tipo}.xlsx`, { upsert: true });
      if (error) throw new Error("Errore upload_url: " + error.message);
      return { url: data.signedUrl };
    }
    case "leggi": {
      if (!TABELLE.includes(body.tabella)) throw new Error("tabella non ammessa");
      const da = Math.max(0, Number(body.offset) || 0);
      const { data, error } = await admin.from(body.tabella).select("*").eq("week_key", weekKey(body.week_key))
        .order(body.tabella === "qdm_trend" ? "promozione" : "id").range(da, da + BLOCCO_LETTURA - 1);
      if (error) throw new Error("Errore lettura: " + error.message);
      return { righe: data || [], fine: (data || []).length < BLOCCO_LETTURA };
    }
    case "pulisci": {
      const wk = weekKey(body.week_key);
      for (const t of TABELLE) {
        const { error } = await admin.from(t).delete().eq("week_key", wk);
        if (error) throw new Error(`Errore pulizia ${t}: ` + error.message);
      }
      return { ok: true };
    }
    case "scrivi": {
      const wk = weekKey(body.week_key);
      if (!TABELLE.includes(body.tabella)) throw new Error("tabella non ammessa");
      const righe = (body.righe || []) as Array<Record<string, unknown>>;
      if (righe.some(r => r.week_key !== wk)) throw new Error("righe di un'altra settimana");
      if (righe.length) {
        const { error } = await admin.from(body.tabella).insert(righe);
        if (error) throw new Error(`Errore ${body.tabella}: ` + error.message);
      }
      return { ok: true, righe: righe.length };
    }
    case "chiudi": {
      const s = body.settimana || {};
      const settimana = { week_key: weekKey(s.week_key), anno: Number(s.anno), cw_from: Number(s.cw_from) || null, cw_to: Number(s.cw_to) || null };
      const { error } = await admin.from("qdm_settimane").upsert(settimana, { onConflict: "week_key" });
      if (error) throw new Error("Errore qdm_settimane: " + error.message);
      // Come cleanupOldWeeks dell'app: dettaglio (recap + top20) solo dell'ultima settimana
      const { data: ult } = await admin.from("qdm_settimane").select("week_key")
        .order("anno", { ascending: false }).order("cw_to", { ascending: false }).limit(1);
      const latest = ult?.[0]?.week_key;
      if (latest) {
        await admin.from("qdm_top20").delete().neq("week_key", latest);
        await admin.from("qdm_recap").delete().neq("week_key", latest);
      }
      if (body.log) await scriviLog(admin, { ...body.log, week_key: settimana.week_key });
      return { ok: true, ultima: latest };
    }
    case "log": {
      await scriviLog(admin, body);
      return { ok: true };
    }
    default:
      throw new Error("azione sconosciuta");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    if (req.method !== "POST") return jsonResponse({ error: "solo POST" }, 405);
    const { data: sec } = await adminClient().from("app_secrets").select("value").eq("name", "qdm_gfk_cron").maybeSingle();
    if (!sec?.value || req.headers.get("x-cron-key") !== sec.value) return jsonResponse({ error: "FORBIDDEN" }, 403);
    return jsonResponse(await azione(await req.json().catch(() => ({}))));
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
