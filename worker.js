// Worker "Finanze" — backend API su Cloudflare — v2
//
// Binding richiesti (dashboard Cloudflare, Settings > Bindings del Worker):
//   - D1 database:      variabile "DB"
//   - Secret:           ANTHROPIC_API_KEY
//   - Secret:           EB_APP_ID        (collegamento bancario)
//   - Secret:           EB_PRIVATE_KEY   (collegamento bancario)
//   - Cron Trigger:     es. "0 */6 * * *" per la sincronizzazione automatica
//
// Rotte:
//   GET    /api/categories
//   POST   /api/categories            { name }
//   GET    /api/expenses?month=YYYY-MM
//   POST   /api/expenses              { amount, category_id, payment_method, note, merchant, expense_date, source }
//   PUT    /api/expenses/:id
//   DELETE /api/expenses/:id
//   GET    /api/summary?month=YYYY-MM
//   GET    /api/stats?month=YYYY-MM             -> totale, conteggio, andamento, categoria principale, medie, serie 6 mesi
//   GET    /api/insight?month=YYYY-MM&refresh=1 -> riepilogo del mese scritto dall'IA (con cache)
//   POST   /api/ask                   { question } -> risposta dell'IA sulle tue spese
//   POST   /api/receipt               { image_base64, media_type } -> legge lo scontrino, NON salva
//   POST   /api/voice                 { text }                     -> interpreta e salva subito
//   GET    /api/bank/status           -> stato del collegamento bancario
//   GET    /api/bank/aspsps           -> elenco banche italiane disponibili
//   GET    /api/bank/connect?bank=..  -> avvia il collegamento, restituisce l'URL della banca
//   GET    /api/bank/callback         -> ritorno dalla banca (registrato su Enable Banking)
//   POST   /api/bank/sync             -> scarica i movimenti e li importa
//   DELETE /api/bank/session          -> scollega il conto

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CATEGORY_PALETTE = [
  "#8FAE6B", "#D4A24C", "#A67CB5", "#6B8CAE",
  "#C1554B", "#4C9A8C", "#D98C4C", "#5B7A99",
  "#B5836B", "#7C9E8F",
];

const ICON_RULES = [
  [/spesa|alimentar|supermerc/, "🛒"],
  [/carburant|benzina|gasoli|diesel/, "⛽"],
  [/bar|caff/, "☕"],
  [/ristor|pranzo|cena|colazion/, "🍽️"],
  [/trasport|parcheggi|autostrad|treno|bus|taxi|pedaggi/, "🚌"],
  [/shopping|abbigliament|vestiti|scarpe/, "🛍️"],
  [/oggett/, "📦"],
  [/casa|bollett|affitto|mutuo|utenz/, "🏠"],
  [/salut|farmaci|medic/, "💊"],
  [/svago|cinema|film|divertiment/, "🎬"],
  [/viagg|vacanz|hotel|volo/, "✈️"],
  [/regal/, "🎁"],
  [/tasse|tribut|f24|impost/, "🧾"],
];

const MONTHS_IT = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];

function guessIcon(name) {
  const n = name.toLowerCase()
    .replace(/[àá]/g,"a").replace(/[èé]/g,"e").replace(/[ìí]/g,"i")
    .replace(/[òó]/g,"o").replace(/[ùú]/g,"u");
  for (const [re, icon] of ICON_RULES) if (re.test(n)) return icon;
  return "📦";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function todayISO() { return new Date().toISOString().slice(0, 10); }
function currentMonth() { return new Date().toISOString().slice(0, 7); }

function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function daysInMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

async function callClaude(env, messages, { maxTokens = 1024 } = {}) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: maxTokens, messages }),
  });
  if (!resp.ok) throw new Error(`Anthropic API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return (textBlock ? textBlock.text : "").replace(/```json|```/g, "").trim();
}

async function nextCategoryColorAndIcon(env, name) {
  const { results } = await env.DB.prepare("SELECT COUNT(*) as n FROM categories").all();
  const color = CATEGORY_PALETTE[results[0].n % CATEGORY_PALETTE.length];
  return { color, icon: guessIcon(name) };
}

async function getOrCreateCategory(env, name) {
  let cat = await env.DB.prepare("SELECT id, name, color, icon FROM categories WHERE name = ?").bind(name).first();
  if (cat) return cat;
  const { color, icon } = await nextCategoryColorAndIcon(env, name);
  return await env.DB
    .prepare("INSERT INTO categories (name, color, icon) VALUES (?, ?, ?) RETURNING id, name, color, icon")
    .bind(name, color, icon).first();
}

async function computeStats(env, month) {
  const cur = await env.DB
    .prepare("SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM expenses WHERE expense_date LIKE ?")
    .bind(`${month}%`).first();

  const prevMonth = shiftMonth(month, -1);
  const prev = await env.DB
    .prepare("SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE expense_date LIKE ?")
    .bind(`${prevMonth}%`).first();

  const { results: byCategory } = await env.DB
    .prepare(
      `SELECT c.name as category, c.color as color, c.icon as icon, SUM(e.amount) as total
       FROM expenses e JOIN categories c ON c.id = e.category_id
       WHERE e.expense_date LIKE ? GROUP BY c.id ORDER BY total DESC`
    ).bind(`${month}%`).all();

  const topCategory = byCategory[0] || null;
  const isCurrentMonth = month === currentMonth();
  const elapsedDays = isCurrentMonth ? new Date().getUTCDate() : daysInMonth(month);

  const trendPercent = prev.total > 0 ? Math.round(((cur.total - prev.total) / prev.total) * 100) : null;

  const sixMonthsAgo = shiftMonth(month, -5);
  const { results: seriesRaw } = await env.DB
    .prepare(
      `SELECT substr(expense_date,1,7) as m, SUM(amount) as total
       FROM expenses WHERE expense_date >= ? AND expense_date < ?
       GROUP BY m`
    ).bind(`${sixMonthsAgo}-01`, `${shiftMonth(month, 1)}-01`).all();

  const seriesMap = Object.fromEntries(seriesRaw.map((r) => [r.m, r.total]));
  const monthlySeries = [];
  for (let i = 5; i >= 0; i--) {
    const m = shiftMonth(month, -i);
    const [, mm] = m.split("-");
    monthlySeries.push({ month: m, label: MONTHS_IT[Number(mm) - 1], total: seriesMap[m] || 0 });
  }

  return {
    month, total: cur.total, count: cur.count,
    avgPerExpense: cur.count ? cur.total / cur.count : 0,
    avgPerDay: elapsedDays ? cur.total / elapsedDays : 0,
    elapsedDays, trendPercent, topCategory, byCategory, monthlySeries,
  };
}

/* ============================================================
   COLLEGAMENTO BANCARIO (Enable Banking)
   Secret richiesti:
     - EB_APP_ID          : ID dell'applicazione (nome del file .pem senza estensione)
     - EB_PRIVATE_KEY     : contenuto del file .pem
   Costante da controllare: APP_URL (indirizzo del sito su Pages)
   ============================================================ */

const EB_API = "https://api.enablebanking.com";
const APP_URL = "https://finanze-40i.pages.dev";

function b64urlFromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromString(str) {
  return b64urlFromBytes(new TextEncoder().encode(str));
}

function pemToPkcs8(pem) {
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    throw new Error("La chiave è in formato PKCS#1. Serve una chiave PKCS#8 (che inizia con BEGIN PRIVATE KEY).");
  }
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

let cachedJwt = null;
async function ebJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.exp > now + 60) return cachedJwt.token;

  if (!env.EB_APP_ID || !env.EB_PRIVATE_KEY) {
    throw new Error("Collegamento bancario non configurato: mancano EB_APP_ID o EB_PRIVATE_KEY.");
  }

  const exp = now + 3600;
  const header = b64urlFromString(JSON.stringify({ typ: "JWT", alg: "RS256", kid: env.EB_APP_ID }));
  const body = b64urlFromString(JSON.stringify({
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: now,
    exp,
  }));
  const signingInput = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(env.EB_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const token = `${signingInput}.${b64urlFromBytes(new Uint8Array(sigBuf))}`;

  cachedJwt = { token, exp };
  return token;
}

async function ebFetch(env, path, options = {}) {
  const token = await ebJwt(env);
  const resp = await fetch(EB_API + path, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Enable Banking ${resp.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

async function getSetting(env, key) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return r ? r.value : null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, String(value)).run();
}

/* Categorizza in blocco i movimenti bancari tramite l'IA */
async function categorizeBank(env, items) {
  const { results: cats } = await env.DB.prepare("SELECT name FROM categories").all();
  const catList = cats.map((c) => c.name).join(", ");
  const list = items.map((it, i) => `${i}: ${it.merchant || "senza nome"} — €${it.amount.toFixed(2)}`).join("\n");

  const prompt = `Assegna una categoria di spesa a ciascun movimento bancario italiano elencato qui sotto.
Categorie disponibili: ${catList}.
Se nessuna si adatta bene, usa una categoria nuova con un nome breve e generico (es. "Casa", "Salute", "Tasse").
Rispondi SOLO con un oggetto JSON, senza testo attorno, nella forma {"0":"NomeCategoria","1":"NomeCategoria",...} usando gli stessi indici numerici della lista.

Movimenti:
${list}`;

  try {
    const raw = await callClaude(env, [{ role: "user", content: prompt }], { maxTokens: 1000 });
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/* Scarica i movimenti e li salva come spese, saltando quelli già presenti */
async function syncBank(env, { days = 30 } = {}) {
  const sess = await env.DB
    .prepare("SELECT session_id, account_uid FROM bank_sessions ORDER BY id DESC LIMIT 1").first();
  if (!sess) return { imported: 0, skipped: 0, error: "Nessun conto collegato" };

  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const collected = [];
  let cont = null, pages = 0;

  do {
    const q = new URLSearchParams({ date_from: from });
    if (cont) q.set("continuation_key", cont);
    const data = await ebFetch(env, `/accounts/${sess.account_uid}/transactions?${q}`);
    (data.transactions || []).forEach((t) => collected.push(t));
    cont = data.continuation_key || null;
    pages++;
  } while (cont && pages < 5);

  const candidates = [];
  for (const t of collected) {
    const indicator = (t.credit_debit_indicator || "").toUpperCase();
    if (indicator !== "DBIT") continue;

    const amount = Math.abs(parseFloat(t.transaction_amount?.amount ?? t.amount ?? 0));
    if (!amount) continue;

    const date = (t.booking_date || t.value_date || t.transaction_date || "").slice(0, 10)
      || new Date().toISOString().slice(0, 10);

    const merchant = t.creditor?.name
      || (Array.isArray(t.remittance_information) ? t.remittance_information[0] : t.remittance_information)
      || t.merchant_category_code || null;

    const ref = t.entry_reference || t.transaction_id
      || `${date}|${amount.toFixed(2)}|${(merchant || "").slice(0, 40)}`;

    const exists = await env.DB.prepare("SELECT id FROM expenses WHERE bank_ref = ?").bind(ref).first();
    if (exists) continue;

    candidates.push({ amount, date, merchant: merchant ? String(merchant).slice(0, 80) : null, ref });
  }

  if (candidates.length === 0) {
    await setSetting(env, "last_sync", new Date().toISOString());
    return { imported: 0, skipped: collected.length };
  }

  const mapping = await categorizeBank(env, candidates);

  let imported = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const catName = mapping[String(i)] || "Oggetti";
    const cat = await getOrCreateCategory(env, catName);
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO expenses (amount, category_id, payment_method, merchant, expense_date, source, bank_ref)
         VALUES (?, ?, 'carta', ?, ?, 'banca', ?)`
      ).bind(c.amount, cat.id, c.merchant, c.date, c.ref).run();
      imported++;
    } catch { /* duplicato o errore singolo: si prosegue */ }
  }

  await setSetting(env, "last_sync", new Date().toISOString());
  return { imported, skipped: collected.length - imported };
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    if (method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      // ---------- CATEGORIE ----------
      if (pathname === "/api/categories" && method === "GET") {
        const { results } = await env.DB
          .prepare("SELECT id, name, color, icon FROM categories ORDER BY name COLLATE NOCASE").all();
        return json(results);
      }

      if (pathname === "/api/categories" && method === "POST") {
        const { name } = await request.json();
        const cleanName = (name || "").trim();
        if (!cleanName) return json({ error: "Nome categoria mancante" }, 400);
        const { color, icon } = await nextCategoryColorAndIcon(env, cleanName);
        const inserted = await env.DB
          .prepare("INSERT INTO categories (name, color, icon) VALUES (?, ?, ?) RETURNING id, name, color, icon")
          .bind(cleanName, color, icon).first();
        return json(inserted, 201);
      }

      // ---------- SPESE ----------
      if (pathname === "/api/expenses" && method === "GET") {
        const month = url.searchParams.get("month") || currentMonth();
        const { results } = await env.DB
          .prepare(
            `SELECT e.id, e.amount, e.payment_method, e.note, e.merchant, e.expense_date, e.source,
                    c.id as category_id, c.name as category_name, c.color as category_color, c.icon as category_icon
             FROM expenses e JOIN categories c ON c.id = e.category_id
             WHERE e.expense_date LIKE ?
             ORDER BY e.expense_date DESC, e.id DESC`
          ).bind(`${month}%`).all();
        return json(results);
      }

      if (pathname === "/api/expenses" && method === "POST") {
        const body = await request.json();
        const {
          amount, category_id, payment_method,
          note = null, merchant = null,
          expense_date = todayISO(), source = "manuale",
        } = body;
        if (!amount || !category_id || !payment_method) {
          return json({ error: "Dati mancanti (amount, category_id, payment_method)" }, 400);
        }
        const inserted = await env.DB
          .prepare(
            `INSERT INTO expenses (amount, category_id, payment_method, note, merchant, expense_date, source)
             VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
          ).bind(amount, category_id, payment_method, note, merchant, expense_date, source).first();
        return json({ id: inserted.id }, 201);
      }

      const expenseMatch = pathname.match(/^\/api\/expenses\/(\d+)$/);
      if (expenseMatch && method === "PUT") {
        const id = expenseMatch[1];
        const body = await request.json();
        const fields = ["amount", "category_id", "payment_method", "note", "expense_date"];
        const updates = []; const values = [];
        for (const f of fields) if (body[f] !== undefined) { updates.push(`${f} = ?`); values.push(body[f]); }
        if (updates.length === 0) return json({ error: "Niente da aggiornare" }, 400);
        values.push(id);
        await env.DB.prepare(`UPDATE expenses SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
        return json({ ok: true });
      }

      if (expenseMatch && method === "DELETE") {
        await env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(expenseMatch[1]).run();
        return json({ ok: true });
      }

      // ---------- RIEPILOGO PER GRAFICO A TORTA ----------
      if (pathname === "/api/summary" && method === "GET") {
        const month = url.searchParams.get("month") || currentMonth();
        const { results } = await env.DB
          .prepare(
            `SELECT c.name as category, c.color as color, c.icon as icon, SUM(e.amount) as total
             FROM expenses e JOIN categories c ON c.id = e.category_id
             WHERE e.expense_date LIKE ? GROUP BY c.id ORDER BY total DESC`
          ).bind(`${month}%`).all();
        const grandTotal = results.reduce((s, r) => s + r.total, 0);
        return json({ month, grandTotal, byCategory: results.map((r) => ({ ...r, percent: grandTotal ? Math.round((r.total / grandTotal) * 100) : 0 })) });
      }

      // ---------- STATISTICHE (dashboard ricca) ----------
      if (pathname === "/api/stats" && method === "GET") {
        const month = url.searchParams.get("month") || currentMonth();
        return json(await computeStats(env, month));
      }

      // ---------- RIEPILOGO SCRITTO DALL'IA (con cache) ----------
      if (pathname === "/api/insight" && method === "GET") {
        const month = url.searchParams.get("month") || currentMonth();
        const refresh = url.searchParams.get("refresh") === "1";

        if (!refresh) {
          const cached = await env.DB.prepare("SELECT text FROM insights WHERE month = ?").bind(month).first();
          if (cached) return json({ text: cached.text, cached: true });
        }

        const stats = await computeStats(env, month);
        if (stats.count === 0) {
          const text = "Nessuna spesa registrata questo mese, ancora.";
          await env.DB.prepare("INSERT OR REPLACE INTO insights (month, text) VALUES (?, ?)").bind(month, text).run();
          return json({ text, cached: false });
        }

        const trendLine = stats.trendPercent === null ? "" : ` L'andamento rispetto al mese scorso è ${stats.trendPercent >= 0 ? "+" : ""}${stats.trendPercent}%.`;
        const prompt = `Scrivi un riepilogo brevissimo (massimo 2 frasi, tono diretto e concreto, in italiano) delle spese di un tecnico che consulta l'app al volo, sul furgone. Non ripetere semplicemente i numeri, dai un giudizio utile se ha senso.
Dati del mese: totale €${stats.total.toFixed(2)}, ${stats.count} spese, categoria principale "${stats.topCategory?.category}" (€${stats.topCategory?.total.toFixed(2)}).${trendLine}
Rispondi SOLO con il testo del riepilogo, senza virgolette, senza introduzioni.`;

        const text = await callClaude(env, [{ role: "user", content: prompt }], { maxTokens: 200 });
        await env.DB.prepare("INSERT OR REPLACE INTO insights (month, text) VALUES (?, ?)").bind(month, text).run();
        return json({ text, cached: false });
      }

      // ---------- DOMANDE IN LINGUAGGIO NATURALE ----------
      if (pathname === "/api/ask" && method === "POST") {
        const { question } = await request.json();
        if (!question) return json({ error: "Domanda mancante" }, 400);

        const twelveMonthsAgo = shiftMonth(currentMonth(), -11);
        const { results: monthlyByCategory } = await env.DB
          .prepare(
            `SELECT substr(e.expense_date,1,7) as month, c.name as category, SUM(e.amount) as total
             FROM expenses e JOIN categories c ON c.id = e.category_id
             WHERE e.expense_date >= ? GROUP BY month, c.name ORDER BY month`
          ).bind(`${twelveMonthsAgo}-01`).all();

        const { results: recent } = await env.DB
          .prepare(
            `SELECT e.expense_date as date, e.amount, e.merchant, e.note, c.name as category
             FROM expenses e JOIN categories c ON c.id = e.category_id
             ORDER BY e.expense_date DESC, e.id DESC LIMIT 60`
          ).all();

        const context = JSON.stringify({ monthlyByCategory, recentExpenses: recent });
        const prompt = `Sei l'assistente dell'app "Finanze". Rispondi alla domanda dell'utente sulle sue spese usando SOLO i dati JSON forniti qui sotto. Se i dati non bastano per rispondere (ad esempio la domanda riguarda patrimonio, vacanze o abbonamenti, sezioni non ancora tracciate), dillo chiaramente invece di inventare. Rispondi in italiano, in modo breve e diretto, con importi in euro.

Dati disponibili (aggregati mensili per categoria negli ultimi 12 mesi, e le ultime 60 spese singole):
${context}

Domanda dell'utente: "${question}"`;

        const answer = await callClaude(env, [{ role: "user", content: prompt }], { maxTokens: 400 });
        return json({ answer });
      }

      // ---------- LETTURA SCONTRINO (foto) ----------
      if (pathname === "/api/receipt" && method === "POST") {
        const { image_base64, media_type, categories = [] } = await request.json();
        if (!image_base64) return json({ error: "Immagine mancante" }, 400);
        const categoryList = categories.map((c) => c.name).join(", ") || "Spesa, Carburante, Uscite, Oggetti";

        const raw = await callClaude(env, [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media_type || "image/jpeg", data: image_base64 } },
            { type: "text", text: `Guarda questo scontrino/ricevuta italiano. Rispondi SOLO con un oggetto JSON, senza testo attorno:
{"amount": numero (totale pagato, punto come separatore decimale), "merchant": "nome del negozio o null", "category": "una tra: ${categoryList} — se nessuna si adatta usa \\"Altro\\"", "date": "YYYY-MM-DD se leggibile, altrimenti null"}` },
          ],
        }]);

        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { return json({ error: "Non sono riuscito a leggere lo scontrino, prova a inserire a mano" }, 422); }
        return json(parsed);
      }

      // ---------- COMANDO VOCALE (Shortcut) ----------
      if (pathname === "/api/voice" && method === "POST") {
        const { text, categories = [] } = await request.json();
        if (!text) return json({ error: "Testo mancante" }, 400);
        const categoryList = categories.map((c) => c.name).join(", ") || "Spesa, Carburante, Uscite, Oggetti";

        const raw = await callClaude(env, [{
          role: "user",
          content: `L'utente ha detto a voce questa frase per registrare una spesa in contanti: "${text}"
Rispondi SOLO con un oggetto JSON, senza testo attorno:
{"amount": numero (punto come separatore decimale), "category": "una tra: ${categoryList} — se nessuna si adatta usa \\"Altro\\"", "note": "eventuale dettaglio residuo, o null"}`,
        }], { maxTokens: 300 });

        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { return json({ error: "Non ho capito la frase, riprova" }, 422); }
        if (!parsed.amount) return json({ error: "Importo non riconosciuto" }, 422);

        const cat = await getOrCreateCategory(env, parsed.category || "Altro");
        const inserted = await env.DB
          .prepare(
            `INSERT INTO expenses (amount, category_id, payment_method, note, expense_date, source)
             VALUES (?, ?, 'contanti', ?, ?, 'voce') RETURNING id`
          ).bind(parsed.amount, cat.id, parsed.note || null, todayISO()).first();
        return json({ id: inserted.id, amount: parsed.amount, category: cat.name }, 201);
      }


      // ---------- COLLEGAMENTO BANCARIO ----------
      if (pathname === "/api/bank/status" && method === "GET") {
        const sess = await env.DB
          .prepare("SELECT account_name, iban, valid_until, created_at FROM bank_sessions ORDER BY id DESC LIMIT 1").first();
        const lastSync = await getSetting(env, "last_sync");
        const configured = Boolean(env.EB_APP_ID && env.EB_PRIVATE_KEY);
        return json({ configured, connected: Boolean(sess), account: sess || null, lastSync });
      }

      if (pathname === "/api/bank/aspsps" && method === "GET") {
        const data = await ebFetch(env, "/aspsps?country=IT");
        const banks = (data.aspsps || []).map((a) => ({ name: a.name, country: a.country, logo: a.logo }));
        return json(banks);
      }

      if (pathname === "/api/bank/connect" && method === "GET") {
        const bank = url.searchParams.get("bank");
        if (!bank) return json({ error: "Banca non specificata" }, 400);
        const validUntil = new Date(Date.now() + 89 * 864e5).toISOString();
        const data = await ebFetch(env, "/auth", {
          method: "POST",
          body: JSON.stringify({
            access: { valid_until: validUntil },
            aspsp: { name: bank, country: "IT" },
            state: crypto.randomUUID(),
            redirect_url: `${new URL(request.url).origin}/api/bank/callback`,
            psu_type: "personal",
          }),
        });
        return json({ url: data.url });
      }

      if (pathname === "/api/bank/callback" && method === "GET") {
        const code = url.searchParams.get("code");
        if (!code) {
          return Response.redirect(`${APP_URL}?bank=errore`, 302);
        }
        try {
          const session = await ebFetch(env, "/sessions", {
            method: "POST",
            body: JSON.stringify({ code }),
          });
          const acc = (session.accounts || [])[0];
          if (!acc) throw new Error("Nessun conto restituito dalla banca");
          const uid = acc.uid || acc.account_id?.iban || acc;
          await env.DB.prepare("DELETE FROM bank_sessions").run();
          await env.DB.prepare(
            "INSERT INTO bank_sessions (session_id, account_uid, account_name, iban, valid_until) VALUES (?, ?, ?, ?, ?)"
          ).bind(
            session.session_id || "",
            String(uid),
            acc.name || acc.product || "Conto",
            acc.account_id?.iban || null,
            session.access?.valid_until || null
          ).run();

          ctx.waitUntil(syncBank(env, { days: 90 }).catch(() => {}));
          return Response.redirect(`${APP_URL}?bank=ok`, 302);
        } catch (e) {
          return Response.redirect(`${APP_URL}?bank=errore`, 302);
        }
      }

      if (pathname === "/api/bank/sync" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        return json(await syncBank(env, { days: body.days || 30 }));
      }

      if (pathname === "/api/bank/session" && method === "DELETE") {
        await env.DB.prepare("DELETE FROM bank_sessions").run();
        return json({ ok: true });
      }

      return json({ error: "Rotta non trovata" }, 404);
    } catch (err) {
      return json({ error: err.message || "Errore interno" }, 500);
    }
  },

  // Sincronizzazione automatica periodica (Cron Trigger)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncBank(env, { days: 14 }).catch(() => {}));
  },
};
