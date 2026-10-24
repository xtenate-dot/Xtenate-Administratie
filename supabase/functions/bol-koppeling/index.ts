// bol-koppeling — haalt je Bol.com-bestellingen op via de Retailer API (v10) en bewaart ze
// in de tabel bol_bestellingen van de ingelogde gebruiker.
//
//   POST /bol-koppeling   body: { van: "JJJJ-MM-DD", tot: "JJJJ-MM-DD" }   (hooguit 31 dagen, hooguit ~91 dagen terug)
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

async function token(id: string, geheim: string): Promise<string | null> {
  const r = await fetch("https://login.bol.com/token?grant_type=client_credentials", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${id}:${geheim}`), Accept: "application/json" },
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  return d?.access_token || null;
}

/** GET met een paar nieuwe pogingen bij "te snel" (429) of een tijdelijke serverfout. */
async function haal(url: string, tok: string): Promise<{ status: number; data: any }> {
  for (let poging = 0; poging < 4; poging++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: ACCEPT } });
    if (r.status === 429 || r.status >= 500) {
      const wachttijd = Math.min(Number(r.headers.get("retry-after")) * 1000 || 1500 * (poging + 1), 8000);
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

async function afhandelen(req: Request): Promise<Response> {
  const auth = req.headers.get("Authorization") || "";
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return Response.json({ ok: false, fout: "Configuratie ontbreekt." }, { status: 500 });
  const supabase = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: gebruiker } = await supabase.auth.getUser();
  if (!gebruiker?.user) return Response.json({ ok: false, fout: "Niet ingelogd." }, { status: 401 });

  const id = Deno.env.get("BOL_CLIENT_ID"), geheim = Deno.env.get("BOL_CLIENT_SECRET");
  if (!id || !geheim) return Response.json({ ok: false, fout: "De Bol-sleutels staan nog niet in Supabase (secrets BOL_CLIENT_ID en BOL_CLIENT_SECRET).", geenSleutels: true }, { status: 412 });

  let body: { van?: string; tot?: string } = {};
  try { body = await req.json(); } catch { /* standaard */ }
  const vandaag = new Date().toISOString().slice(0, 10);
  const tot = datumOk(body.tot) ? body.tot! : vandaag;
  const van = datumOk(body.van) ? body.van! : new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  if (van > tot) return Response.json({ ok: false, fout: "De begindatum ligt na de einddatum." }, { status: 400 });
  const lijstDagen = dagen(van, tot);
  if (lijstDagen.length > MAX_DAGEN) return Response.json({ ok: false, fout: `Kies hooguit ${MAX_DAGEN} dagen tegelijk.` }, { status: 400 });

  const tok = await token(id, geheim);
  if (!tok) return Response.json({ ok: false, fout: "Inloggen bij Bol is mislukt. Controleer de sleutels in Supabase." }, { status: 502 });

  const start = Date.now();
  const orderIds = new Map<string, string | null>();
  let laatsteDagKlaar = van, onvolledig = false;
  // 1. Welke bestellingen zijn er per dag gewijzigd? (nieuwe, verzonden, geannuleerde)
  for (const dag of lijstDagen) {
    if (Date.now() - start > TIJDBUDGET_MS) { onvolledig = true; break; }
    for (let pagina = 1; pagina <= 20; pagina++) {
      const q = new URLSearchParams({ "fulfilment-method": "ALL", status: "ALL", "latest-change-date": dag, page: String(pagina) });
      const r = await haal(`https://api.bol.com/retailer/orders?${q}`, tok);
      if (r.status === 401 || r.status === 403) return Response.json({ ok: false, fout: "Bol weigert de toegang. Controleer de sleutels." }, { status: 502 });
      if (!r.data) { if (r.status === 404) break; return Response.json({ ok: false, fout: "Ophalen bij Bol mislukt." }, { status: 502 }); }
      const lijst = r.data.orders || [];
      for (const o of lijst) if (o?.orderId) orderIds.set(String(o.orderId), o.orderPlacedDateTime || null);
      if (lijst.length < 50) break;
    }
    laatsteDagKlaar = dag;
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
  if (bestellingen.length) {
    const rijen = bestellingen.filter((b) => b.order_id).map((b) => ({
      user_id: gebruiker.user!.id,
      order_id: b.order_id,
      besteld: b.besteld,
      datum: b.besteld ? b.besteld.slice(0, 10) : null,
      items: b.items,
      opgehaald_op: new Date().toISOString(),
    }));
    for (let i = 0; i < rijen.length; i += 100) {
      const { error } = await supabase.from("bol_bestellingen").upsert(rijen.slice(i, i + 100), { onConflict: "user_id,order_id" });
      if (error) return Response.json({ ok: false, fout: "Opslaan van de bestellingen is mislukt." }, { status: 500 });
    }
  }
  return Response.json({
    ok: true, van, tot, gevonden: ids.length, opgeslagen: bestellingen.length,
    onvolledig, laatsteDagKlaar,
  }, { status: 200 });
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
