// webshop-koppeling — koppelt je WooCommerce-webshop (MijnMagie) aan de administratie.
//
//   POST /webshop-koppeling   body: { van, tot }                 -> bestellingen ophalen (hooguit 31 dagen) en bewaren in webshop_bestellingen
//   POST /webshop-koppeling   body: { actie: "info" }            -> is de webshop ingesteld en bereikbaar?
//   POST /webshop-koppeling   body: { actie: "voorraad", regels: [{ sku, voorraad }] }
//                                                                -> zet de voorraad in de webshop op die aantallen (absoluut, geen optelling)
//   POST /webshop-koppeling/dagelijks   (door pg_cron, met geheim uit bank_cron_geheim: de laatste 7 dagen voor elke gebruiker
//                                        die al webshopbestellingen heeft)
//
// Secrets in Supabase: WEBSHOP_URL (bijv. https://mijnmagie.nl), WEBSHOP_KEY (ck_...), WEBSHOP_SECRET (cs_...).
// De sleutel maak je in WooCommerce > Instellingen > Geavanceerd > REST API, met lees- en schrijfrechten.
//
// Beveiliging (zelfde aanpak als bol-koppeling):
//   - De aanroeper komt uitsluitend uit auth.getUser() op de doorgegeven gebruikers-JWT.
//   - Databaseverkeer loopt via een client met die JWT (RLS: alleen eigen rijen). Geen service-role, behalve in de nachtronde.
//   - De webshopsleutels staan alleen als Supabase-secret en komen nooit in een antwoord of logregel.
//   - Van klanten bewaren we geen naam, adres, e-mail of telefoon: alleen land, bedragen en artikelen.
//   - In de webshop wordt alleen de voorraad aangepast, en alleen bij artikelen die je zelf meestuurt.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "https://xtenate-dot.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const MAX_DAGEN = 31;
const MAX_REGELS = 200;
const TIJDBUDGET_MS = 100_000;

type Db = ReturnType<typeof createClient>;
const wacht = (ms: number) => new Promise((r) => setTimeout(r, ms));
const datumOk = (x?: unknown) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
const getal = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;

function instelling(): { basis: string; key: string; secret: string } | null {
  const url = Deno.env.get("WEBSHOP_URL")?.trim().replace(/\/+$/, "");
  const key = Deno.env.get("WEBSHOP_KEY")?.trim(), secret = Deno.env.get("WEBSHOP_SECRET")?.trim();
  if (!url || !key || !secret || !/^https:\/\//.test(url)) return null;
  return { basis: `${url}/wp-json/wc/v3`, key, secret };
}

/**
 * Eén verzoek aan de WooCommerce REST API. Eerst met Basic Auth; sommige gedeelde hostings halen die kop
 * weg, dan proberen we het één keer met de sleutel als query-parameter (WooCommerce staat dat toe over HTTPS).
 * Bij "te snel" (429) of een tijdelijke serverfout volgen een paar nieuwe pogingen.
 */
async function woo(w: NonNullable<ReturnType<typeof instelling>>, methode: string, pad: string, body?: unknown):
  Promise<{ status: number; data: any; totaalPaginas: number }> {
  let viaQuery = false;
  for (let poging = 0; poging < 5; poging++) {
    const url = new URL(w.basis + pad);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (viaQuery) { url.searchParams.set("consumer_key", w.key); url.searchParams.set("consumer_secret", w.secret); }
    else headers.Authorization = "Basic " + btoa(`${w.key}:${w.secret}`);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(url, { method: methode, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 401 && !viaQuery) { viaQuery = true; continue; }
    if (r.status === 429 || r.status >= 500) { await wacht(Math.min(2000 * (poging + 1), 10000)); continue; }
    const data = r.ok ? await r.json().catch(() => null) : null;
    return { status: r.status, data, totaalPaginas: Number(r.headers.get("x-wp-totalpages")) || 1 };
  }
  return { status: 503, data: null, totaalPaginas: 0 };
}

/** Een bestelling zonder persoonsgegevens: alleen wat de administratie nodig heeft. */
function normaliseer(o: any) {
  const items = (o?.line_items || []).map((i: any) => ({
    sku: String(i.sku ?? "").slice(0, 100),
    naam: String(i.name ?? "").slice(0, 200),
    aantal: getal(i.quantity),
    prijs: r2(getal(i.total) + getal(i.total_tax)),   // regeltotaal incl. eventuele btw, na korting
    product_id: getal(i.product_id),
    variatie_id: getal(i.variation_id),
  }));
  const terug = (o?.refunds || []).reduce((s: number, x: any) => s + Math.abs(getal(x.total)), 0);
  return {
    order_id: String(o?.id ?? ""),
    nummer: String(o?.number ?? o?.id ?? ""),
    status: String(o?.status ?? ""),
    besteld: o?.date_created_gmt ? String(o.date_created_gmt) + "Z" : null,
    betaald: o?.date_paid_gmt ? String(o.date_paid_gmt) + "Z" : null,
    totaal: r2(getal(o?.total)),
    verzendkosten: r2(getal(o?.shipping_total) + getal(o?.shipping_tax)),
    terugbetaald: r2(terug),
    betaalmethode: String(o?.payment_method_title ?? "").slice(0, 60),
    land: String(o?.shipping?.country || o?.billing?.country || "").slice(0, 2),
    items,
  };
}

async function verwerk(van: string, tot: string, supabase: Db, userId: string): Promise<Response> {
  const w = instelling();
  if (!w) return Response.json({ ok: false, fout: "De webshop-sleutels staan nog niet in Supabase (WEBSHOP_URL, WEBSHOP_KEY, WEBSHOP_SECRET).", geenSleutels: true }, { status: 412 });
  const start = Date.now();
  let onvolledig = false;
  const bestellingen: ReturnType<typeof normaliseer>[] = [];
  // Alles wat in deze periode is aangemaakt of gewijzigd (nieuw, betaald, geannuleerd, terugbetaald).
  const q = (pagina: number) => `/orders?${new URLSearchParams({
    modified_after: `${van}T00:00:00`, modified_before: `${tot}T23:59:59`, dates_are_gmt: "true",
    status: "any", per_page: "50", page: String(pagina), orderby: "id", order: "asc",
  })}`;
  for (let pagina = 1; pagina <= 40; pagina++) {
    if (Date.now() - start > TIJDBUDGET_MS) { onvolledig = true; break; }
    const r = await woo(w, "GET", q(pagina));
    if (r.status === 401 || r.status === 403) return Response.json({ ok: false, fout: "De webshop weigert de toegang. Controleer de REST API-sleutel (lees- en schrijfrechten)." }, { status: 502 });
    if (!Array.isArray(r.data)) return Response.json({ ok: false, fout: `Ophalen bij de webshop mislukt (status ${r.status}, pagina ${pagina}).` }, { status: 502 });
    for (const o of r.data) bestellingen.push(normaliseer(o));
    if (pagina >= r.totaalPaginas || r.data.length < 50) break;
  }
  const rijen = bestellingen.filter((b) => b.order_id).map((b) => ({
    user_id: userId, ...b, datum: b.besteld ? b.besteld.slice(0, 10) : null, opgehaald_op: new Date().toISOString(),
  }));
  for (let i = 0; i < rijen.length; i += 100) {
    const { error } = await supabase.from("webshop_bestellingen").upsert(rijen.slice(i, i + 100), { onConflict: "user_id,order_id" });
    if (error) return Response.json({ ok: false, fout: "Opslaan van de webshopbestellingen is mislukt. Is de tabel webshop_bestellingen aangemaakt?" }, { status: 500 });
  }
  return Response.json({ ok: true, van, tot, gevonden: bestellingen.length, opgeslagen: rijen.length, onvolledig }, { status: 200 });
}

/** Zet per SKU de voorraad in de webshop. Werkt voor gewone producten en voor variaties. */
async function zetVoorraad(regels: unknown): Promise<Response> {
  const w = instelling();
  if (!w) return Response.json({ ok: false, fout: "De webshop-sleutels staan nog niet in Supabase.", geenSleutels: true }, { status: 412 });
  if (!Array.isArray(regels) || !regels.length) return Response.json({ ok: false, fout: "Geen voorraadregels meegestuurd." }, { status: 400 });
  if (regels.length > MAX_REGELS) return Response.json({ ok: false, fout: `Stuur hooguit ${MAX_REGELS} artikelen tegelijk.` }, { status: 400 });
  const schoon = new Map<string, number>();
  for (const x of regels as any[]) {
    const sku = String(x?.sku ?? "").trim(), n = Math.floor(Number(x?.voorraad));
    if (!sku || sku.length > 100 || !Number.isFinite(n)) return Response.json({ ok: false, fout: "Een regel mist een geldige SKU of voorraad." }, { status: 400 });
    schoon.set(sku, Math.max(0, n));
  }
  const start = Date.now();
  const resultaat: { sku: string; ok: boolean; voorraad?: number; was?: number | null; melding?: string }[] = [];
  for (const [sku, voorraad] of schoon) {
    if (Date.now() - start > TIJDBUDGET_MS) { resultaat.push({ sku, ok: false, melding: "niet aan toegekomen (tijd op)" }); continue; }
    const zoek = await woo(w, "GET", `/products?${new URLSearchParams({ sku, per_page: "5" })}`);
    if (zoek.status === 401 || zoek.status === 403) return Response.json({ ok: false, fout: "De webshop weigert de toegang. Controleer de REST API-sleutel." }, { status: 502 });
    const lijst = Array.isArray(zoek.data) ? zoek.data.filter((p: any) => String(p?.sku) === sku) : [];
    if (lijst.length !== 1) { resultaat.push({ sku, ok: false, melding: lijst.length ? "SKU komt vaker voor in de webshop" : "SKU niet gevonden in de webshop" }); continue; }
    const p = lijst[0];
    const pad = p.type === "variation" && p.parent_id ? `/products/${p.parent_id}/variations/${p.id}` : `/products/${p.id}`;
    const was = p.manage_stock ? getal(p.stock_quantity) : null;
    const r = await woo(w, "PUT", pad, { manage_stock: true, stock_quantity: voorraad });
    if (r.data && getal(r.data.stock_quantity) === voorraad) resultaat.push({ sku, ok: true, voorraad, was });
    else resultaat.push({ sku, ok: false, melding: `bijwerken mislukt (status ${r.status})` });
  }
  return Response.json({ ok: resultaat.every((r) => r.ok), resultaat }, { status: 200 });
}

async function afhandelen(req: Request): Promise<Response> {
  const auth = req.headers.get("Authorization") || "";
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return Response.json({ ok: false, fout: "Configuratie ontbreekt." }, { status: 500 });
  const supabase = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: gebruiker } = await supabase.auth.getUser();
  if (!gebruiker?.user) return Response.json({ ok: false, fout: "Niet ingelogd." }, { status: 401 });

  let body: { actie?: string; van?: string; tot?: string; regels?: unknown } = {};
  try { body = await req.json(); } catch { /* standaard */ }

  if (body.actie === "info") {
    const w = instelling();
    if (!w) return Response.json({ ok: true, ingesteld: false }, { status: 200 });
    const r = await woo(w, "GET", "/products?per_page=1");
    return Response.json({ ok: true, ingesteld: true, bereikbaar: Array.isArray(r.data), status: r.status }, { status: 200 });
  }
  if (body.actie === "voorraad") return await zetVoorraad(body.regels);

  const vandaag = new Date().toISOString().slice(0, 10);
  const tot = datumOk(body.tot) ? body.tot! : vandaag;
  const van = datumOk(body.van) ? body.van! : new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  if (van > tot) return Response.json({ ok: false, fout: "De begindatum ligt na de einddatum." }, { status: 400 });
  const dagen = Math.round((Date.parse(tot) - Date.parse(van)) / 864e5) + 1;
  if (dagen > MAX_DAGEN) return Response.json({ ok: false, fout: `Kies hooguit ${MAX_DAGEN} dagen tegelijk.` }, { status: 400 });
  return await verwerk(van, tot, supabase, gebruiker.user.id);
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
  if (!instelling()) return Response.json({ ok: true, gebruikers: 0, opgeslagen: 0 }, { status: 200 });
  // Alleen gebruikers die de webshoppagina al eens hebben gebruikt (er staan al bestellingen van hen).
  const { data: rijen } = await admin.from("webshop_bestellingen").select("user_id").limit(1000);
  const gebruikers = [...new Set((rijen || []).map((r: { user_id: string }) => r.user_id))];
  const tot = new Date().toISOString().slice(0, 10);
  const van = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  let opgeslagen = 0, mislukt = 0;
  for (const uid of gebruikers) {
    const r = await verwerk(van, tot, admin, uid);
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
