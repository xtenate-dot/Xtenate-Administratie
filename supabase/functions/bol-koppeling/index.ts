// bol-koppeling — haalt je Bol.com-bestellingen op via de Retailer API (v10) en bewaart ze
// in de tabel bol_bestellingen van de ingelogde gebruiker.
//
//   POST /bol-koppeling   body: { van, tot, account?: "1" | "2" | "alle" }   (hooguit 31 dagen, hooguit ~91 dagen terug)
//   POST /bol-koppeling   body: { actie: "info" }   -> welke Bol-accounts zijn ingesteld (nummer + naam)
//   Account 1: BOL_CLIENT_ID, BOL_CLIENT_SECRET, BOL_NAAM (naam is optioneel). Account 2: BOL_CLIENT_ID_2, BOL_CLIENT_SECRET_2, BOL_NAAM_2. Tot 4 accounts.
//
// Beveiliging:
//   - De aanroeper komt uitsluitend uit auth.getUser() op de doorgegeven gebruikers-JWT.
//   - Alle databaseverkeer loopt via een client met die JWT (RLS: alleen eigen rijen). Geen service-role.
//   - De Bol-sleutels (BOL_CLIENT_ID / BOL_CLIENT_SECRET) staan alleen als Supabase-secret en komen
//     nooit in een antwoord of logregel terecht. Antwoorden bevatten alleen vaste, algemene meldingen.
//   - Alleen lezen bij Bol: er worden geen bestellingen verzonden, geannuleerd of gewijzigd.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "https://xtenate-dot.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const ACCEPT = "application/vnd.retailer.v10+json";
const MAX_DAGEN = 31;
const TIJDBUDGET_MS = 100_000;   // daarna stoppen we netjes en melden we dat het onvolledig is

const wacht = (ms: number) => new Promise((r) => setTimeout(r, ms));
const datumOk = (x?: unknown) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);

function dagen(van: string, tot: string): string[] {
  const uit: string[] = [];
  const d = new Date(van + "T12:00:00Z"), eind = new Date(tot + "T12:00:00Z");
  while (d <= eind) { uit.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return uit;
}

let laatsteTokenFout = "";
async function token(id: string, geheim: string): Promise<string | null> {
  const r = await fetch("https://login.bol.com/token?grant_type=client_credentials", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${id}:${geheim}`), Accept: "application/json" },
  });
  if (!r.ok) {
    const t = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    laatsteTokenFout = `Bol antwoordde ${r.status}${t ? ": " + t : ""}. Lengte client ID: ${id.length}, lengte secret: ${geheim.length}.`;
    return null;
  }
  const d = await r.json().catch(() => null);
  return d?.access_token || null;
}

/** GET met een paar nieuwe pogingen bij "te snel" (429) of een tijdelijke serverfout. */
async function haal(url: string, tok: string): Promise<{ status: number; data: any }> {
  for (let poging = 0; poging < 6; poging++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: ACCEPT } });
    if (r.status === 429 || r.status >= 500) {
      const wachttijd = Math.min(Number(r.headers.get("retry-after")) * 1000 || 2000 * (poging + 1), 15000);
      await wacht(wachttijd);
      continue;
    }
    const data = r.ok ? await r.json().catch(() => null) : null;
    return { status: r.status, data };
  }
  return { status: 429, data: null };
}

const getal = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

function normaliseer(o: any) {
  const items = (o?.orderItems || []).map((i: any) => ({
    id: String(i.orderItemId ?? ""),
    ean: String(i.product?.ean ?? i.ean ?? ""),
    titel: String(i.product?.title ?? i.title ?? "").slice(0, 200),
    aantal: getal(i.quantity),
    geannuleerd: getal(i.quantityCancelled),
    prijs: getal(i.unitPrice),
    commissie: getal(i.commission),
    methode: String(i.fulfilment?.method ?? ""),
    annuleringsverzoek: !!i.cancellationRequest,
  }));
  return {
    order_id: String(o?.orderId ?? ""),
    besteld: o?.orderPlacedDateTime ? String(o.orderPlacedDateTime) : null,
    items,
  };
}

/** Welke Bol-accounts zijn ingesteld? Account 1 = BOL_CLIENT_ID/BOL_CLIENT_SECRET, account 2 = ..._2, enz. */
function accounts(): { nummer: string; naam: string; id: string; geheim: string }[] {
  const uit = [];
  for (const n of ["1", "2", "3", "4"]) {
    const sfx = n === "1" ? "" : `_${n}`;
    const id = Deno.env.get(`BOL_CLIENT_ID${sfx}`)?.trim(), geheim = Deno.env.get(`BOL_CLIENT_SECRET${sfx}`)?.trim();
    if (id && geheim) uit.push({ nummer: n, naam: Deno.env.get(`BOL_NAAM${sfx}`) || `Bol-account ${n}`, id, geheim });
  }
  return uit;
}

async function afhandelen(req: Request): Promise<Response> {
  const auth = req.headers.get("Authorization") || "";
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return Response.json({ ok: false, fout: "Configuratie ontbreekt." }, { status: 500 });
  const supabase = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: gebruiker } = await supabase.auth.getUser();
  if (!gebruiker?.user) return Response.json({ ok: false, fout: "Niet ingelogd." }, { status: 401 });

  const alle = accounts();
  if (!alle.length) return Response.json({ ok: false, fout: "De Bol-sleutels staan nog niet in Supabase (secrets BOL_CLIENT_ID en BOL_CLIENT_SECRET).", geenSleutels: true }, { status: 412 });

  let body: { actie?: string; van?: string; tot?: string; account?: string } = {};
  try { body = await req.json(); } catch { /* standaard */ }
  if (body.actie === "info") {
    return Response.json({ ok: true, accounts: alle.map((a) => ({ nummer: a.nummer, naam: a.naam })) }, { status: 200 });
  }

  const gekozen = body.account && body.account !== "alle" ? alle.filter((a) => a.nummer === String(body.account)) : alle;
  if (!gekozen.length) return Response.json({ ok: false, fout: "Dit Bol-account is niet ingesteld." }, { status: 400 });

  const vandaag = new Date().toISOString().slice(0, 10);
  const tot = datumOk(body.tot) ? body.tot! : vandaag;
  const van = datumOk(body.van) ? body.van! : new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  if (van > tot) return Response.json({ ok: false, fout: "De begindatum ligt na de einddatum." }, { status: 400 });
  const lijstDagen = dagen(van, tot);
  if (lijstDagen.length > MAX_DAGEN) return Response.json({ ok: false, fout: `Kies hooguit ${MAX_DAGEN} dagen tegelijk.` }, { status: 400 });

  const start = Date.now();
  let gevonden = 0, opgeslagen = 0, onvolledig = false;
  const perAccount: { nummer: string; naam: string; gevonden: number; opgeslagen: number }[] = [];
  for (const acc of gekozen) {
    const tok = await token(acc.id, acc.geheim);
    if (!tok) return Response.json({ ok: false, fout: `Inloggen bij Bol is mislukt voor "${acc.naam}". Controleer de sleutels in Supabase. ${laatsteTokenFout}` }, { status: 502 });

    // 1. Welke bestellingen zijn er per dag gewijzigd? (nieuwe, verzonden, geannuleerde)
    const orderIds = new Map<string, string | null>();
    for (const dag of lijstDagen) {
      if (onvolledig) break;
      if (Date.now() - start > TIJDBUDGET_MS) { onvolledig = true; break; }
      for (let pagina = 1; pagina <= 20; pagina++) {
        const q = new URLSearchParams({ "fulfilment-method": "ALL", status: "ALL", "latest-change-date": dag, page: String(pagina) });
        const r = await haal(`https://api.bol.com/retailer/orders?${q}`, tok);
        if (r.status === 401 || r.status === 403) return Response.json({ ok: false, fout: `Bol weigert de toegang voor "${acc.naam}". Controleer de sleutels.` }, { status: 502 });
        if (!r.data) { if (r.status === 404) break; if (r.status === 429) { onvolledig = true; break; } return Response.json({ ok: false, fout: `Ophalen bij Bol mislukt (status ${r.status}, dag ${dag}, pagina ${pagina}).` }, { status: 502 }); }
        const lijst = r.data.orders || [];
        for (const o of lijst) if (o?.orderId) orderIds.set(String(o.orderId), o.orderPlacedDateTime || null);
        if (lijst.length < 50) break;
      }
    }

    // 2. Per bestelling de details (prijzen, commissie), een paar tegelijk.
    const ids = [...orderIds.keys()];
    const bestellingen: ReturnType<typeof normaliseer>[] = [];
    let volgende = 0;
    const werker = async () => {
      while (volgende < ids.length) {
        if (Date.now() - start > TIJDBUDGET_MS + 30_000) { onvolledig = true; return; }
        const orderId = ids[volgende++];
        const r = await haal(`https://api.bol.com/retailer/orders/${encodeURIComponent(orderId)}`, tok);
        if (r.data) bestellingen.push(normaliseer(r.data));
      }
    };
    await Promise.all([werker(), werker(), werker(), werker()]);

    // 3. Bewaren (alleen eigen rijen; bestaande bestellingen worden bijgewerkt, bijvoorbeeld na een annulering).
    const rijen = bestellingen.filter((b) => b.order_id).map((b) => ({
      user_id: gebruiker.user!.id,
      account: acc.nummer,
      order_id: b.order_id,
      besteld: b.besteld,
      datum: b.besteld ? b.besteld.slice(0, 10) : null,
      items: b.items,
      opgehaald_op: new Date().toISOString(),
    }));
    for (let i = 0; i < rijen.length; i += 100) {
      const { error } = await supabase.from("bol_bestellingen").upsert(rijen.slice(i, i + 100), { onConflict: "user_id,account,order_id" });
      if (error) return Response.json({ ok: false, fout: "Opslaan van de bestellingen is mislukt." }, { status: 500 });
    }
    gevonden += ids.length; opgeslagen += rijen.length;
    perAccount.push({ nummer: acc.nummer, naam: acc.naam, gevonden: ids.length, opgeslagen: rijen.length });
  }
  return Response.json({ ok: true, van, tot, gevonden, opgeslagen, onvolledig, perAccount }, { status: 200 });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const r = await afhandelen(req);
    const h = new Headers(r.headers);
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);
    return new Response(r.body, { status: r.status, headers: h });
  } catch {
    const h = new Headers({ "Content-Type": "application/json", ...CORS });
    return new Response(JSON.stringify({ ok: false, fout: "Onverwachte fout." }), { status: 500, headers: h });
  }
});
