// bol-koppeling — haalt je Bol.com-bestellingen op via de Retailer API (v10) en bewaart ze
// in de tabel bol_bestellingen van de ingelogde gebruiker.
//
//   POST /bol-koppeling   body: { van, tot, account?: "1" | "2" | "alle" }   (hooguit 31 dagen, hooguit ~91 dagen terug)
//   POST /bol-koppeling/dagelijks   (door pg_cron, met geheim uit bank_cron_geheim: de laatste 7 dagen voor elke gebruiker met Bol-bestellingen)
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

/** Alleen de vorm van een antwoord (veldnamen, getallen, vaste codes); vrije tekst en namen worden niet getoond. */
function vorm(x: any, diepte = 0): any {
  if (x === null || x === undefined) return x;
  if (Array.isArray(x)) return x.length ? [vorm(x[0], diepte + 1), `(${x.length} stuks)`] : [];
  if (typeof x === "object") return diepte > 5 ? "{…}" : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, vorm(v, diepte + 1)]));
  if (typeof x === "string") return /^[A-Z][A-Z_]+$/.test(x) || /^\d{4}-\d{2}-\d{2}T/.test(x) ? x : `tekst(${x.length})`;
  return x;
}

async function afhandelenRetourProbe(acc: ReturnType<typeof accounts>[number]): Promise<Response> {
  const tok = await token(acc.id, acc.geheim);
  if (!tok) return Response.json({ ok: false, fout: `Inloggen bij Bol is mislukt voor "${acc.naam}". ${laatsteTokenFout}` }, { status: 502 });
  const uit: Record<string, unknown> = {};
  for (const handled of ["true", "false"]) {
    const r = await haal(`https://api.bol.com/retailer/returns?handled=${handled}&page=1`, tok);
    const lijst = r.data?.returns || [];
    uit[`handled=${handled}`] = { status: r.status, aantal: lijst.length, sleutels: r.data ? Object.keys(r.data) : null, voorbeeld: lijst.length ? vorm(lijst[0]) : null };
    if (lijst.length) {
      const d = await haal(`https://api.bol.com/retailer/returns/${encodeURIComponent(String(lijst[0].returnId))}`, tok);
      uit[`handled=${handled} detail`] = { status: d.status, voorbeeld: d.data ? vorm(d.data) : null };
    }
  }
  return Response.json({ ok: true, ...uit }, { status: 200 });
}

/** Alle retouren van een account (afgehandeld en nog niet afgehandeld), één rij per retourregel (rma). */
async function haalRetouren(tok: string): Promise<{ rijen: any[]; fout: string }> {
  const rijen: any[] = [];
  for (const handled of ["true", "false"]) {
    for (let pagina = 1; pagina <= 10; pagina++) {
      const r = await haal(`https://api.bol.com/retailer/returns?handled=${handled}&page=${pagina}`, tok);
      if (!r.data) { if (r.status === 404) break; return { rijen, fout: `status ${r.status}` }; }
      const lijst = r.data.returns || [];
      for (const ret of lijst) {
        for (const it of ret.returnItems || []) {
          const res = (it.processingResults || []) as any[];
          const som = (f: (x: any) => boolean) => res.filter(f).reduce((n, x) => n + getal(x.quantity), 0);
          rijen.push({
            rma_id: String(it.rmaId ?? ""),
            return_id: String(ret.returnId ?? ""),
            order_id: String(it.orderId ?? ""),
            ean: String(it.ean ?? ""),
            aantal: getal(it.expectedQuantity),
            geaccepteerd: som((x) => x.processingResult === "ACCEPTED"),
            afgewezen: som((x) => x.processingResult === "REJECTED"),
            geregistreerd: ret.registrationDateTime ? String(ret.registrationDateTime) : null,
            datum: ret.registrationDateTime ? String(ret.registrationDateTime).slice(0, 10) : null,
            reden: String(it.returnReason?.mainReason ?? "").slice(0, 120),
            afgehandeld: !!it.handled,
            resultaten: res.map((x) => ({ aantal: getal(x.quantity), uitkomst: String(x.processingResult ?? ""), afhandeling: String(x.handlingResult ?? "") })),
            methode: String(ret.fulfilmentMethod ?? ""),
          });
        }
      }
      if (!lijst.length) break;
    }
  }
  return { rijen, fout: "" };
}

type Db = ReturnType<typeof createClient>;
/** Haalt de bestellingen van de gekozen accounts op en bewaart ze voor één gebruiker. */
async function verwerk(gekozen: ReturnType<typeof accounts>, van: string, tot: string, supabase: Db, userId: string): Promise<Response> {
  const lijstDagen = dagen(van, tot);
  const start = Date.now();
  let gevonden = 0, opgeslagen = 0, onvolledig = false;
  const perAccount: { nummer: string; naam: string; gevonden: number; opgeslagen: number; retouren: number; retourFout: string }[] = [];
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
      user_id: userId,
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
    // 4. Retouren (een fout hier mag het ophalen van bestellingen niet breken, bijvoorbeeld als de tabel nog ontbreekt).
    let retouren = 0, retourFout = "";
    if (Date.now() - start < TIJDBUDGET_MS + 60_000) {
      const ret = await haalRetouren(tok);
      retourFout = ret.fout;
      const rr = ret.rijen.filter((x) => x.rma_id).map((x) => ({ user_id: userId, account: acc.nummer, ...x, opgehaald_op: new Date().toISOString() }));
      for (let i = 0; i < rr.length; i += 100) {
        const { error } = await supabase.from("bol_retouren").upsert(rr.slice(i, i + 100), { onConflict: "user_id,account,rma_id" });
        if (error) { retourFout = "opslaan"; break; }
      }
      if (!retourFout) retouren = rr.length;
    }
    perAccount.push({ nummer: acc.nummer, naam: acc.naam, gevonden: ids.length, opgeslagen: rijen.length, retouren, retourFout });
  }
  return Response.json({ ok: true, van, tot, gevonden, opgeslagen, onvolledig, perAccount }, { status: 200 });
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

  if (body.actie === "retouren-probe") return await afhandelenRetourProbe(alle.find((a) => a.nummer === String(body.account || "1")) || alle[0]);

  const gekozen = body.account && body.account !== "alle" ? alle.filter((a) => a.nummer === String(body.account)) : alle;
  if (!gekozen.length) return Response.json({ ok: false, fout: "Dit Bol-account is niet ingesteld." }, { status: 400 });

  const vandaag = new Date().toISOString().slice(0, 10);
  const tot = datumOk(body.tot) ? body.tot! : vandaag;
  const van = datumOk(body.van) ? body.van! : new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  if (van > tot) return Response.json({ ok: false, fout: "De begindatum ligt na de einddatum." }, { status: 400 });
  const lijstDagen = dagen(van, tot);
  if (lijstDagen.length > MAX_DAGEN) return Response.json({ ok: false, fout: `Kies hooguit ${MAX_DAGEN} dagen tegelijk.` }, { status: 400 });

  return await verwerk(gekozen, van, tot, supabase, gebruiker.user.id);
}

// ─── Nachtelijke ronde (aangeroepen door pg_cron met het geheim uit bank_cron_geheim) ───
async function gelijk(a: string, b: string): Promise<boolean> {
  const h = async (x: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)));
  const [x, y] = [await h(a), await h(b)];
  let v = 0;
  for (let i = 0; i < x.length; i++) v |= x[i] ^ y[i];
  return v === 0;
}

async function afhandelenDagelijks(req: Request): Promise<Response> {
  const gegeven = req.headers.get("x-cron-secret") || "";
  const url = Deno.env.get("SUPABASE_URL"), sleutel = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !sleutel || gegeven.length < 20) return Response.json({ ok: false, fout: "Niet toegestaan." }, { status: 401 });
  const admin = createClient(url, sleutel, { auth: { persistSession: false } });
  const { data: g } = await admin.from("bank_cron_geheim").select("geheim").eq("id", 1).maybeSingle();
  if (!g?.geheim || !(await gelijk(String(g.geheim), gegeven))) return Response.json({ ok: false, fout: "Niet toegestaan." }, { status: 401 });
  const alle = accounts();
  if (!alle.length) return Response.json({ ok: true, gebruikers: 0, opgeslagen: 0 }, { status: 200 });
  // Alleen gebruikers die de Bol-pagina al eens hebben gebruikt (er staan al bestellingen van hen).
  const { data: rijen } = await admin.from("bol_bestellingen").select("user_id").limit(1000);
  const gebruikers = [...new Set((rijen || []).map((r: { user_id: string }) => r.user_id))];
  const tot = new Date().toISOString().slice(0, 10);
  const van = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  let opgeslagen = 0, mislukt = 0;
  for (const uid of gebruikers) {
    const r = await verwerk(alle, van, tot, admin, uid);
    const d = await r.json().catch(() => null);
    if (d?.ok) opgeslagen += Number(d.opgeslagen) || 0; else mislukt += 1;
  }
  return Response.json({ ok: true, gebruikers: gebruikers.length, opgeslagen, mislukt }, { status: 200 });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const r = new URL(req.url).pathname.endsWith("/dagelijks") ? await afhandelenDagelijks(req) : await afhandelen(req);
    const h = new Headers(r.headers);
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);
    return new Response(r.body, { status: r.status, headers: h });
  } catch {
    const h = new Headers({ "Content-Type": "application/json", ...CORS });
    return new Response(JSON.stringify({ ok: false, fout: "Onverwachte fout." }), { status: 500, headers: h });
  }
});
