// bank-koppeling — fase 4b-2: de echte (niet-diagnostische) Edge Function
// die een bankrekening koppelt via Enable Banking. Twee acties:
//
//   POST /bank-koppeling              -> auth-start: maakt een koppelpoging
//     aan (bank_koppeling_pogingen), roept POST /auth aan bij Enable Banking
//     met state = de poging-id, geeft de redirect-URL terug.
//
//   POST /bank-koppeling/sessies      -> sessies-inwisselen: wisselt de
//     code in via POST /sessions, en roept koppel_bankrekening() aan met
//     het eerste account -- die database-functie (SECURITY DEFINER, fase
//     4b-2 databasekant) is de ENIGE plek die session_id/account_uid/
//     geldig_tot mag zetten.
//
// Beveiliging:
//   - De aanroeper komt uitsluitend uit auth.getUser() op de doorgegeven
//     gebruikers-JWT. Er wordt nergens een user_id uit de request-body
//     gelezen -- die bestaat simpelweg niet als veld.
//   - Alle databaseverkeer loopt via een Supabase-client die de doorgegeven
//     Authorization-header gebruikt (dus als de rol authenticated, met
//     dezelfde RLS/kolomrechten als de rest van de app). De
//     service-role-sleutel wordt nergens gelezen of gebruikt.
//   - De Enable Banking-privésleutel en het app-id komen nooit in een
//     antwoord of logregel terecht -- alleen gebruikt om lokaal een JWT
//     mee te ondertekenen.
//   - Geen enkel antwoord bevat een ruwe respons van Enable Banking of een
//     error.message (van Supabase of van een lokale catch) -- uitsluitend
//     vaste, algemene meldingen met een statuscode.
//   - Sessies-inwisselen zoekt de koppelpoging op (state, RLS-beschermd op
//     user_id, niet verlopen) vóórdat de code naar Enable Banking gaat; bij
//     geen (eigen, geldige) poging wordt de code niet verbruikt.
//     koppel_bankrekening() blijft de gezaghebbende controle op state/iban/
//     geldig_tot.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const LIVE_APP_REDIRECT_URL = "https://xtenate-dot.github.io/Xtenate-Administratie/";

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlJson(obj: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(obj)));
}

function pemToDer(pem: string): ArrayBuffer {
  // Tolerant voor aanhalingstekens en letterlijke "\\n" die bij het plakken kunnen ontstaan.
  const t = String(pem).trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n").replace(/\r/g, "");
  const m = t.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (RSA )?PRIVATE KEY-----/);
  if (!m) throw new Error("Geen PRIVATE KEY-blok gevonden in het geheim");
  if (m[1]) throw new Error("Sleutel is PKCS#1 (RSA PRIVATE KEY); PKCS#8 (PRIVATE KEY) is nodig");
  const b64 = m[2].replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return bytes.buffer;
}

async function ondertekenJwt(appId: string, privateKeyPem: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: appId };
  const nu = Math.floor(Date.now() / 1000);
  const payload = { iss: "enablebanking.com", aud: "api.enablebanking.com", iat: nu, exp: nu + 300 };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const handtekening = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(handtekening))}`;
}

/** Bouwt een Supabase-client die praat als de aanroeper zelf -- nooit de
 *  service-role-sleutel. Retourneert ook de geverifieerde gebruiker (of
 *  null), via auth.getUser() op diezelfde doorgegeven header. */
async function clientEnGebruiker(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data, error } = await supabase.auth.getUser();
  return { supabase, user: error ? null : data.user };
}

function leesEnableBankingSecrets(): { appId: string; privateKey: string } | null {
  const appId = Deno.env.get("ENABLE_BANKING_APP_ID");
  const privateKey = Deno.env.get("ENABLE_BANKING_PRIVATE_KEY");
  if (!appId || !privateKey) return null;
  return { appId, privateKey };
}

async function afhandelenAuthStart(req: Request): Promise<Response> {
  const { supabase, user } = await clientEnGebruiker(req);
  if (!user) {
    return Response.json({ ok: false, fout: "Niet ingelogd." }, { status: 401 });
  }

  const secrets = leesEnableBankingSecrets();
  if (!secrets) {
    return Response.json({ ok: false, fout: "Enable Banking-secrets ontbreken." }, { status: 500 });
  }

  let body: { aspsp_naam?: string; country?: string } = {};
  try { body = await req.json(); } catch { /* lege body is prima, dan gelden de standaardwaarden */ }
  const country = body.country || "NL";

  let jwt: string;
  try {
    jwt = await ondertekenJwt(secrets.appId, secrets.privateKey);
  } catch {
    // Geen err.message in het antwoord -- kan interne details lekken.
    return Response.json({ ok: false, fout: "Kon de aanvraag niet voorbereiden." }, { status: 500 });
  }

  const aspspsResp = await fetch(`https://api.enablebanking.com/aspsps?country=${encodeURIComponent(country)}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!aspspsResp.ok) {
    // Geen aspspsResp.status doorgeven -- alleen onze eigen, vaste statuscode.
    return Response.json({ ok: false, fout: "Ophalen van banken bij Enable Banking mislukt." }, { status: 502 });
  }
  const aspspsData = await aspspsResp.json();
  const lijst = (aspspsData?.aspsps || []) as { name: string; country: string }[];
  const gekozen = body.aspsp_naam
    ? lijst.find((a) => a.name === body.aspsp_naam)
    : (lijst.find((a) => a.name === "Revolut") || lijst.find((a) => /mock/i.test(a.name)) || lijst[0]);
  if (!gekozen) {
    return Response.json({ ok: false, fout: "Geen (passende) bank gevonden om te koppelen." }, { status: 404 });
  }

  // De poging aanmaken als de aanroeper zelf -- gewone, RLS-beschermde
  // insert (geen enkel bijzonder recht nodig, geen gevoelige kolommen hier).
  // De trigger op deze tabel ruimt meteen verlopen pogingen van deze
  // gebruiker op en weigert een zesde gelijktijdige poging.
  const { data: poging, error: pogingFout } = await supabase
    .from("bank_koppeling_pogingen")
    .insert({ user_id: user.id, aspsp_naam: gekozen.name })
    .select("state")
    .single();

  if (pogingFout || !poging) {
    // Geen pogingFout.message in het antwoord -- altijd dezelfde, vaste tekst.
    return Response.json({ ok: false, fout: "Aanmaken van koppelpoging mislukt." }, { status: 400 });
  }

  const authBody = {
    access: { valid_until: new Date(Date.now() + 89 * 24 * 60 * 60 * 1000).toISOString() },
    aspsp: { name: gekozen.name, country: gekozen.country },
    state: poging.state,
    redirect_url: LIVE_APP_REDIRECT_URL,
    psu_type: "business", // Revolut Business; de database accepteert maximaal 90 dagen
  };

  const authResp = await fetch("https://api.enablebanking.com/auth", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(authBody),
  });
  const authData = await authResp.json().catch(() => null);

  if (!authResp.ok || !authData?.url) {
    // Geen authResp.status en geen antwoord (authData) doorgeven -- dat is
    // de ruwe respons van Enable Banking.
    return Response.json({ ok: false, fout: "Starten van de autorisatie bij Enable Banking mislukt." }, { status: 502 });
  }

  return Response.json({ ok: true, redirect_url: authData.url, state: poging.state }, { status: 200 });
}

async function afhandelenSessiesInwisselen(req: Request): Promise<Response> {
  const { supabase, user } = await clientEnGebruiker(req);
  if (!user) {
    return Response.json({ ok: false, fout: "Niet ingelogd." }, { status: 401 });
  }

  const secrets = leesEnableBankingSecrets();
  if (!secrets) {
    return Response.json({ ok: false, fout: "Enable Banking-secrets ontbreken." }, { status: 500 });
  }

  let body: { code?: string; state?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, fout: "Verwacht JSON-body {code, state}." }, { status: 400 });
  }
  const { code, state } = body;
  if (!code || typeof code !== "string" || !state || typeof state !== "string") {
    return Response.json({ ok: false, fout: "Velden 'code' en 'state' zijn verplicht." }, { status: 400 });
  }

  // Vóórdat de code naar Enable Banking gaat: de poging opzoeken via een
  // gewone, RLS-beschermde select (user_id = auth.uid(), zie het beleid
  // "eigen_rijen_lezen"). Bestaat de poging niet, is ze verlopen, of is ze
  // van een andere gebruiker -- RLS maakt "niet gevonden" en "van een
  // ander" ononderscheidbaar, precies zoals gewenst -- dan dezelfde
  // algemene fout, en de code wordt niet verbruikt (geen aanroep naar
  // Enable Banking). koppel_bankrekening() blijft de gezaghebbende
  // controle; dit is alleen een goedkope check vooraf.
  const { data: poging } = await supabase
    .from("bank_koppeling_pogingen")
    .select("state")
    .eq("state", state)
    .gt("verloopt_op", new Date().toISOString())
    .maybeSingle();

  if (!poging) {
    return Response.json({ ok: false, fout: "Koppelpoging ongeldig of verlopen." }, { status: 400 });
  }

  let jwt: string;
  try {
    jwt = await ondertekenJwt(secrets.appId, secrets.privateKey);
  } catch {
    // Geen err.message in het antwoord -- kan interne details lekken.
    return Response.json({ ok: false, fout: "Kon de aanvraag niet voorbereiden." }, { status: 500 });
  }

  const sessionsResp = await fetch("https://api.enablebanking.com/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const sessionsData = await sessionsResp.json().catch(() => null);

  if (!sessionsResp.ok || !sessionsData?.session_id) {
    // Geen sessionsResp.status en geen antwoord (sessionsData) doorgeven --
    // dat is de ruwe respons van Enable Banking.
    return Response.json({ ok: false, fout: "Sessie-inwisseling bij Enable Banking mislukt." }, { status: 502 });
  }

  const accounts = (sessionsData.accounts || []) as Record<string, unknown>[];
  const eersteAccount = accounts[0];
  if (!eersteAccount) {
    return Response.json({ ok: false, fout: "Geen rekeningen in de sessie gevonden." }, { status: 502 });
  }

  // IBAN halen uit account_id.iban, met all_account_ids als terugval --
  // in de praktijk (fase 3-test) stond account_id soms leeg terwijl
  // all_account_ids het IBAN wel bevatte.
  const accountId = eersteAccount.account_id as { iban?: string } | null;
  let iban = accountId?.iban || null;
  if (!iban && Array.isArray(eersteAccount.all_account_ids)) {
    const ibanEntry = (eersteAccount.all_account_ids as { scheme_name?: string; identification?: string }[])
      .find((a) => a.scheme_name === "IBAN");
    iban = ibanEntry?.identification || null;
  }
  const accountUid = (eersteAccount.uid as string) || null;
  const geldigTot = sessionsData.access?.valid_until || null;

  if (!iban) {
    return Response.json({ ok: false, fout: "Geen IBAN te herleiden uit de eerste rekening." }, { status: 502 });
  }

  // De enige plek die de drie beschermde kolommen mag zetten -- dezelfde
  // client (doorgegeven gebruikers-JWT), dus ook deze RPC-aanroep loopt via
  // de rol authenticated, niet via een verhoogd recht.
  const { data: koppelingId, error: koppelFout } = await supabase.rpc("koppel_bankrekening", {
    p_state: state,
    p_iban: iban,
    p_session_id: sessionsData.session_id,
    p_account_uid: accountUid,
    p_geldig_tot: geldigTot,
  });

  if (koppelFout) {
    // Geen koppelFout.message in het antwoord -- die kan Postgres-interne
    // tekst bevatten. koppel_bankrekening() is en blijft de gezaghebbende
    // controle; alleen het resultaat (gelukt/niet) komt naar buiten.
    return Response.json({ ok: false, fout: "Koppelen van de bankrekening mislukt." }, { status: 400 });
  }

  return Response.json({ ok: true, koppeling_id: koppelingId }, { status: 200 });
}


type Bedrag = { amount?: string; currency?: string };
type Partij = { name?: string | null };
type Rekening = { iban?: string | null } | null;
type Entry = {
  entry_reference?: string | null; transaction_id?: string | null;
  booking_date?: string | null; value_date?: string | null; transaction_date?: string | null;
  transaction_amount?: Bedrag; credit_debit_indicator?: string; status?: string;
  creditor?: Partij | null; debtor?: Partij | null;
  creditor_account?: Rekening; debtor_account?: Rekening;
  remittance_information?: string[] | null; note?: string | null;
};

async function afhandelenOphalen(req: Request): Promise<Response> {
  const { supabase, user } = await clientEnGebruiker(req);
  if (!user) return Response.json({ ok: false, fout: "Niet ingelogd." }, { status: 401 });
  const secrets = leesEnableBankingSecrets();
  if (!secrets) return Response.json({ ok: false, fout: "Enable Banking-secrets ontbreken." }, { status: 500 });

  let body: { koppeling_id?: string; dagen?: number } = {};
  try { body = await req.json(); } catch { /* standaardwaarden */ }
  const koppelingId = body.koppeling_id;
  if (!koppelingId || typeof koppelingId !== "string") {
    return Response.json({ ok: false, fout: "koppeling_id ontbreekt." }, { status: 400 });
  }
  const dagen = Math.min(Math.max(Math.floor(Number(body.dagen) || 45), 1), 89);

  // Sessie en rekening komen uit een database-functie die alleen eigen, geldige koppelingen teruggeeft.
  const { data: rijen, error: sessieFout } = await supabase.rpc("bank_sessie_voor_ophalen", { p_id: koppelingId });
  const sessie = Array.isArray(rijen) ? rijen[0] : null;
  if (sessieFout || !sessie?.account_uid) {
    return Response.json({ ok: false, fout: "Koppeling niet gevonden of verlopen. Koppel de rekening opnieuw." }, { status: 404 });
  }
  if (sessie.geldig_tot && new Date(sessie.geldig_tot).getTime() < Date.now()) {
    return Response.json({ ok: false, fout: "De toestemming van de bank is verlopen. Koppel de rekening opnieuw." }, { status: 410 });
  }

  let jwt: string;
  try { jwt = await ondertekenJwt(secrets.appId, secrets.privateKey); }
  catch { return Response.json({ ok: false, fout: "Kon de aanvraag niet voorbereiden." }, { status: 500 }); }

  const vanaf = new Date(Date.now() - dagen * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const resultaat: Record<string, unknown>[] = [];
  let doorgaan: string | null = null;
  for (let pagina = 0; pagina < 20; pagina++) {
    const q = new URLSearchParams({ date_from: vanaf });
    if (doorgaan) q.set("continuation_key", doorgaan);
    const r = await fetch(`https://api.enablebanking.com/accounts/${encodeURIComponent(sessie.account_uid)}/transactions?${q}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) {
      const kort = r.status === 401 || r.status === 403 || r.status === 422 ? "De bank weigert de toegang (is de toestemming verlopen?)." : "Ophalen bij de bank mislukt.";
      return Response.json({ ok: false, fout: kort }, { status: 502 });
    }
    const d = await r.json().catch(() => null);
    for (const e of ((d?.transactions || []) as Entry[])) {
      const datum = String(e.booking_date || e.value_date || e.transaction_date || "").slice(0, 10);
      const bedrag = Number(e.transaction_amount?.amount);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || !Number.isFinite(bedrag)) continue;
      const credit = e.credit_debit_indicator === "CRDT";
      const tegen = credit ? e.debtor : e.creditor;
      const tegenIban = credit ? e.debtor_account?.iban : e.creditor_account?.iban;
      const omschr = (e.remittance_information || []).join(" ").trim() || e.note || "";
      resultaat.push({
        id: e.entry_reference || e.transaction_id || `${datum}|${bedrag}|${tegen?.name || omschr}`.slice(0, 120),
        datum,
        totaal: credit ? Math.abs(bedrag) : -Math.abs(bedrag),
        naam: tegen?.name || "",
        omschr: omschr.slice(0, 200),
        tegenIban: tegenIban || "",
        status: String(e.status || ""),
      });
    }
    doorgaan = d?.continuation_key || null;
    if (!doorgaan) break;
  }
  return Response.json({ ok: true, vanaf, transacties: resultaat }, { status: 200 });
}

const CORS = {
  "Access-Control-Allow-Origin": "https://xtenate-dot.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function metCors(r: Response): Response {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
}

Deno.serve(async (req: Request) => {
  // De browser vraagt eerst met OPTIONS of de aanroep vanaf GitHub Pages mag.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/sessies")) {
      return metCors(await afhandelenSessiesInwisselen(req));
    }
    if (url.pathname.endsWith("/ophalen")) {
      return metCors(await afhandelenOphalen(req));
    }
    return metCors(await afhandelenAuthStart(req));
  } catch {
    // Geen err.message in het antwoord -- ook deze catch-all mag geen
    // interne details lekken.
    return metCors(Response.json({ ok: false, fout: "Onverwachte fout." }, { status: 500 }));
  }
});
