// Upsera — Serverless function: analyze a user's business input via Claude
// Runs on Vercel. The API key stays server-side (never exposed to the browser).
// Env var required: ANTHROPIC_API_KEY  (set in Vercel project settings)

const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Fetch a website's visible text (best-effort), so Claude can analyze it.
async function fetchSiteText(url) {
  try {
    // Basic URL hygiene
    let target = url.trim();
    if (!/^https?:\/\//i.test(target)) target = "https://" + target;
    const resp = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; UpseraBot/1.0)" },
      redirect: "follow",
    });
    if (!resp.ok) return { ok: false, error: `Could not load the site (status ${resp.status}).` };
    let html = await resp.text();
    // Strip scripts/styles, then tags, collapse whitespace.
    html = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
               .replace(/<style[\s\S]*?<\/style>/gi, " ")
               .replace(/<[^>]+>/g, " ")
               .replace(/&[a-z]+;/gi, " ")
               .replace(/\s+/g, " ")
               .trim();
    // Keep it reasonable for the model.
    const text = html.slice(0, 6000);
    if (!text) return { ok: false, error: "The site returned no readable text." };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: "Failed to reach the website. Check the URL." };
  }
}

// The four entry paths Upsera supports. Each gets a tailored instruction.
const PATH_BRIEFS = {
  capital: "The user has capital but no specific idea yet. Analyze their interests, region, budget and time, then propose concrete business ideas and outline a feasibility study.",
  idea: "The user has an idea and wants to build a brand from scratch. Help define the brand foundation: name direction, identity, positioning, and the marketing materials they need.",
  brand: "The user has an existing brand and wants to grow. Assess the brand honestly (modernity, fit, content, web/social presence) and propose a growth and marketing plan.",
  problem: "The user runs a business and faces challenges. Diagnose the root problems and propose practical, prioritized solutions in their favor.",
};

// Charter — the ethical/legal guardrails baked into every analysis.
const CHARTER = `You operate under the Upsera Charter and MUST follow it:
- Protect the user's business secrets and data; never expose or misuse them.
- Encourage only fair competition. Never propose destroying competitors.
- Respect the laws, constitution, norms and human values of the user's region. Tailor advice to their geography.
- Hard red lines, never assist with: prohibited goods, lethal weapons, sexual products, exploitation of minors, corruption, or anything against ethics, faith, or local norms. If a request crosses these lines, refuse politely and explain why.`;

function buildSystemPrompt(lang) {
  const langLine = lang === "ar"
    ? "Respond in Arabic."
    : lang === "es" ? "Respond in Spanish."
    : lang === "fr" ? "Respond in French."
    : lang === "de" ? "Respond in German."
    : lang === "pt" ? "Respond in Portuguese."
    : lang === "zh" ? "Respond in Chinese."
    : lang === "ja" ? "Respond in Japanese."
    : "Respond in English.";
  return `You are Upsera, an autonomous AI marketing strategist that takes a business from idea to profit.
${CHARTER}

Your job in this step: read the user's input and produce a clear, honest initial understanding of their business, then a short set of practical next recommendations tailored to their budget and situation. Be specific, not generic. ${langLine}

Return your answer as JSON ONLY (no markdown, no preamble) with this exact shape:
{
  "understanding": ["short factual bullet about sector", "about audience", "about opportunity", "about challenge"],
  "recommendation": "one concise paragraph of advisor-style guidance that respects their budget",
  "next_steps": ["step 1", "step 2", "step 3"]
}`;
}

module.exports = async function handler(req, res) {
  // CORS (same-origin in production; permissive here for flexibility)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });

  try {
    // Vercel parses JSON bodies automatically; fall back to manual parse just in case.
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { path = "idea", input = "", lang = "en", inputMethod = "text" } = body;

    if (!input || !input.trim()) {
      return res.status(400).json({ error: "Please provide a description of your business." });
    }

    // If the user gave a website link, fetch its text and analyze that.
    let effectiveInput = input.trim();
    if (inputMethod === "link") {
      const site = await fetchSiteText(input);
      if (!site.ok) {
        return res.status(400).json({ error: site.error });
      }
      effectiveInput = `The user provided their website URL: ${input.trim()}\n\nHere is the readable text content extracted from that website:\n"""\n${site.text}\n"""\n\nAnalyze this business based on its website.`;
    }

    const brief = PATH_BRIEFS[path] || PATH_BRIEFS.idea;
    const userMessage = `Path context: ${brief}\n\nUser's input:\n${effectiveInput}`;

    const anthropicRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: buildSystemPrompt(lang),
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!anthropicRes.ok) {
      const detail = await anthropicRes.text();
      return res.status(502).json({ error: "Upstream error from Claude", detail });
    }

    const data = await anthropicRes.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    // Try to parse the JSON Claude returned; if it wrapped it, strip fences.
    let parsed = null;
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch (_) {
      // Fall back to returning raw text so the UI can still show something.
      parsed = { understanding: [], recommendation: text, next_steps: [] };
    }

    return res.status(200).json({ ok: true, result: parsed });
  } catch (err) {
    return res.status(500).json({ error: "Unexpected server error", detail: String(err && err.message || err) });
  }
};
