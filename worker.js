// Worker "Finanze" — backend API su Cloudflare — v2
//
// Binding richiesti (dashboard Cloudflare, Settings > Bindings del Worker):
//   - D1 database:      variabile "DB"
//   - Secret:           ANTHROPIC_API_KEY
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

export default {
  async fetch(request, env) {
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

      return json({ error: "Rotta non trovata" }, 404);
    } catch (err) {
      return json({ error: err.message || "Errore interno" }, 500);
    }
  },
};