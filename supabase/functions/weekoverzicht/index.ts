// weekoverzicht — stuurt elke week een samenvatting per e-mail (via Resend).
//
//   POST /weekoverzicht   (door pg_cron, met geheim uit bank_cron_geheim in de header x-cron-secret)
//   body: { proef?: true }   -> onderwerp krijgt "[proef]"
//
// Inhoud: te late en binnenkort vervallende facturen, nieuwe bankregels in de inbox,
// vaste posten die deze maand nog niet binnen zijn, en de Bol-verkopen van de afgelopen week.
//
// Secrets: RESEND_API_KEY (verplicht). WEEKOVERZICHT_NAAR (optioneel, standaard xtenate@gmail.com).
// Verzenden gebeurt vanaf onboarding@resend.dev; zonder eigen domein levert Resend alleen aan het adres
// waarmee het Resend-account is aangemaakt. De sleutel komt nooit in een antwoord of logregel terecht.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
type Rij = Record<string, any>;

const euro = (n: number) => "€ " + (Math.round(n * 100) / 100).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const dd = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}`;
const dagenTussen = (a: string, b: string) => Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 864e5);

async function gelijk(a: string, b: string): Promise<boolean> {
  const h = async (x: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)));
  const [x, y] = [await h(a), await h(b)];
  let v = 0;
  for (let i = 0; i < x.length; i++) v |= x[i] ^ y[i];
  return v === 0;
}

// ─── Facturen ────────────────────────────────────────────────────────────────

function openFacturen(lijst: Rij[], tx: Map<string, number>, vandaag: string) {
  const uit: { f: Rij; rest: number; dagenTeLaat: number }[] = [];
  for (const f of lijst || []) {
    if (!f || f.status === "oninbaar") continue;
    const ids: unknown[] = Array.isArray(f.txIds) ? f.txIds : [];
    let rest: number;
    if (!ids.length) rest = f.status === "betaald" ? 0 : Number(f.bedrag) || 0;
    else {
      const betaald = ids.reduce<number>((s, id) => {
        const t = f.toegewezen?.[String(id)];
        return s + (t != null ? Number(t) || 0 : tx.get(String(id)) || 0);
      }, 0);
      rest = Math.max(0, (Number(f.bedrag) || 0) - betaald);
    }
    if (rest <= 0.01) continue;
    const d = f.vervaldatum ? dagenTussen(vandaag, f.vervaldatum) : 0;
    uit.push({ f, rest, dagenTeLaat: d > 0 ? d : 0 });
  }
  return uit;
}

// ─── Vaste posten (zelfde regels als de pagina Terugkerend) ──────────────────

const mediaan = (l: number[]) => { const s = [...l].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const maandMin = (m: string, n: number) => { const [j, mm] = m.split("-").map(Number); const t = j * 12 + (mm - 1) - n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, "0")}`; };
const sleutelVan = (b: Rij) => (b.type === "inkomst" ? "i:" : "u:") + String(b.naam || "").toLowerCase().replace(/[0-9]+/g, "").replace(/[^a-zà-ÿ ]+/g, " ").replace(/\s+/g, " ").trim();

function verwachtNogNiet(boekingen: Rij[], vandaag: string) {
  const nu = vandaag.slice(0, 7), dagNu = Number(vandaag.slice(8, 10)), start = maandMin(nu, 5);
  const groepen = new Map<string, { naam: string; type: string; perMaand: Map<string, { som: number; aantal: number }>; dagen: number[] }>();
  for (const b of boekingen) {
    if (b.type !== "uitgave" && b.type !== "inkomst") continue;
    if (!b.naam || !String(b.naam).trim() || !b.datum) continue;
    const m = String(b.datum).slice(0, 7);
    if (m < start || m > nu) continue;
    const k = sleutelVan(b);
    if (k.length < 3) continue;
    const g = groepen.get(k) || { naam: String(b.naam).trim(), type: b.type, perMaand: new Map(), dagen: [] };
    const p = g.perMaand.get(m) || { som: 0, aantal: 0 };
    p.som += Number(b.bedrag) || 0; p.aantal++;
    g.perMaand.set(m, p); g.dagen.push(Number(String(b.datum).slice(8, 10)));
    groepen.set(k, g);
  }
  const uit: { naam: string; bedrag: number; dag: number; type: string }[] = [];
  for (const g of groepen.values()) {
    if (g.perMaand.size < 3) continue;
    if ([...g.perMaand.values()].filter((p) => p.aantal > 1).length > g.perMaand.size / 2) continue;
    const bedragen = [...g.perMaand.values()].map((p) => p.som);
    const med = mediaan(bedragen);
    if (!(med > 0) || bedragen.filter((x) => Math.abs(x - med) <= Math.max(1, med * 0.2)).length < 3) continue;
    const laatste = [...g.perMaand.keys()].sort().pop()!;
    if (g.perMaand.has(nu) || laatste < maandMin(nu, 1)) continue;   // al binnen, of gestopt
    const dag = Math.round(mediaan(g.dagen));
    if (dagNu >= dag + 3) uit.push({ naam: g.naam, bedrag: Math.round(med * 100) / 100, dag, type: g.type });
  }
  return uit.sort((a, b) => b.bedrag - a.bedrag);
}

// ─── Mail opbouwen ───────────────────────────────────────────────────────────

const tabel = (kop: string[], rijen: string[][]) =>
  `<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>${kop.map((k, i) => `<th style="text-align:${i === kop.length - 1 && /bedrag|rest/i.test(k) ? "right" : "left"};padding:4px 8px;border-bottom:1px solid #ddd;color:#555">${k}</th>`).join("")}</tr></thead><tbody>${
    rijen.map((r) => `<tr>${r.map((c, i) => `<td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:${i === r.length - 1 && /^€/.test(c) ? "right" : "left"}">${c}</td>`).join("")}</tr>`).join("")
  }</tbody></table>`;
const kop = (t: string) => `<h3 style="margin:22px 0 6px;font-size:15px">${t}</h3>`;

async function bouwMail(admin: ReturnType<typeof createClient>, uid: string, vandaag: string) {
  const sinds = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const [fac, bx, inbox, bol] = await Promise.all([
    admin.from("app_data").select("waarde").eq("user_id", uid).eq("sleutel", "facturen").maybeSingle(),
    admin.from("boekingen").select("legacy_id, datum, bedrag, naam, type").eq("user_id", uid).gte("datum", sinds).limit(5000),
    admin.from("bank_inbox").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("status", "nieuw"),
    admin.from("bol_bestellingen").select("datum, items").eq("user_id", uid).gte("datum", new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10)).limit(1000),
  ]);
  const boekingen: Rij[] = bx.data || [];
  const tx = new Map<string, number>(boekingen.map((b) => [String(b.legacy_id), Number(b.bedrag) || 0]));
  const open = openFacturen(fac.data?.waarde?.lijst || [], tx, vandaag);
  const teLaat = open.filter((o) => o.dagenTeLaat > 0).sort((a, b) => b.dagenTeLaat - a.dagenTeLaat);
  const binnenkort = open.filter((o) => o.dagenTeLaat === 0 && o.f.vervaldatum && dagenTussen(o.f.vervaldatum, vandaag) >= 0 && dagenTussen(o.f.vervaldatum, vandaag) <= 7);
  const rijF = (o: { f: Rij; rest: number; dagenTeLaat: number }) => [
    esc(o.f.soort === "debiteur" ? "Verkoop" : "Inkoop"), esc(o.f.relatie || "(geen relatie)"), esc(o.f.factuurnummer || "—"),
    o.f.vervaldatum ? dd(o.f.vervaldatum) + (o.dagenTeLaat ? ` (${o.dagenTeLaat} d te laat)` : "") : "—", euro(o.rest),
  ];
  const KOP_F = ["Soort", "Relatie", "Factuur", "Vervalt", "Rest"];

  const nieuweInbox = inbox.count || 0;
  const vast = verwachtNogNiet(boekingen, vandaag);

  let orders = 0, stuks = 0, omzet = 0, commissie = 0;
  for (const o of bol.data || []) {
    orders++;
    for (const it of (o.items || []) as Rij[]) {
      const n = Math.max(0, (Number(it.aantal) || 0) - (Number(it.geannuleerd) || 0));
      stuks += n; omzet += n * (Number(it.prijs) || 0); commissie += Number(it.commissie) || 0;
    }
  }

  const blokken: string[] = [];
  blokken.push(kop(`Facturen die te laat zijn (${teLaat.length})`) + (teLaat.length ? tabel(KOP_F, teLaat.slice(0, 15).map(rijF)) : '<p style="color:#555;margin:4px 0">Geen.</p>'));
  blokken.push(kop(`Vervallen binnen 7 dagen (${binnenkort.length})`) + (binnenkort.length ? tabel(KOP_F, binnenkort.slice(0, 15).map(rijF)) : '<p style="color:#555;margin:4px 0">Geen.</p>'));
  blokken.push(kop("Bank") + `<p style="margin:4px 0">${nieuweInbox ? `<b>${nieuweInbox}</b> nieuwe bankregel${nieuweInbox === 1 ? "" : "s"} wacht${nieuweInbox === 1 ? "" : "en"} in de inbox om verwerkt te worden.` : "Geen nieuwe bankregels in de inbox."}</p>`);
  if (vast.length) blokken.push(kop(`Vaste posten die deze maand nog niet binnen zijn (${vast.length})`) + tabel(["Naam", "Soort", "Meestal rond", "Bedrag"], vast.slice(0, 12).map((v) => [esc(v.naam), v.type === "inkomst" ? "Inkomst" : "Uitgave", `de ${v.dag}e`, euro(v.bedrag)])));
  blokken.push(kop("Bol.com, afgelopen 7 dagen") + `<p style="margin:4px 0">${orders ? `${orders} bestelling${orders === 1 ? "" : "en"}, ${stuks} stuks, omzet ${euro(omzet)}, commissie ${euro(commissie)}.` : "Geen bestellingen."}</p>`);

  const alles = teLaat.length + binnenkort.length + nieuweInbox + vast.length;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:auto;color:#222">
    <h2 style="margin:0 0 4px">Weekoverzicht Xtenate</h2><div style="color:#777;font-size:12px;margin-bottom:6px">${esc(vandaag.split("-").reverse().join("-"))}</div>
    ${blokken.join("")}
    <p style="margin-top:26px;font-size:12px;color:#777"><a href="https://xtenate-dot.github.io/Xtenate-Administratie/">Open de administratie</a></p></div>`;
  return { html, onderwerp: alles ? `Weekoverzicht: ${alles} punt${alles === 1 ? "" : "en"} om te bekijken` : "Weekoverzicht: alles op orde" };
}

// ─── Aanroep ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  try {
    const gegeven = req.headers.get("x-cron-secret") || "";
    const url = Deno.env.get("SUPABASE_URL"), sleutel = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !sleutel || gegeven.length < 20) return json({ ok: false, fout: "Niet toegestaan." }, 401);
    const admin = createClient(url, sleutel, { auth: { persistSession: false } });
    const { data: g } = await admin.from("bank_cron_geheim").select("geheim").eq("id", 1).maybeSingle();
    if (!g?.geheim || !(await gelijk(String(g.geheim), gegeven))) return json({ ok: false, fout: "Niet toegestaan." }, 401);

    const resend = Deno.env.get("RESEND_API_KEY");
    if (!resend) return json({ ok: false, fout: "RESEND_API_KEY ontbreekt." }, 500);
    const naar = (Deno.env.get("WEEKOVERZICHT_NAAR") || "xtenate@gmail.com").trim();
    const body = await req.json().catch(() => ({}));
    const vandaag = new Date().toISOString().slice(0, 10);

    const { data: rijen } = await admin.from("app_data").select("user_id").eq("sleutel", "facturen").limit(100);
    const gebruikers = [...new Set((rijen || []).map((r: Rij) => r.user_id as string))];
    let verzonden = 0, mislukt = 0, laatsteStatus = 0;
    for (const uid of gebruikers) {
      const m = await bouwMail(admin, uid, vandaag);
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "Xtenate Administratie <onboarding@resend.dev>", to: [naar], subject: (body?.proef ? "[proef] " : "") + m.onderwerp, html: m.html }),
      });
      laatsteStatus = r.status;
      if (r.ok) verzonden++; else mislukt++;
    }
    return json({ ok: mislukt === 0, gebruikers: gebruikers.length, verzonden, mislukt, resendStatus: laatsteStatus });
  } catch {
    return json({ ok: false, fout: "Onverwachte fout." }, 500);
  }
});
