const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let universeCache = { at: 0, data: null };

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&#039;", "'");
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseUniverseHtml(html) {
  const table = html.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/i)?.[0];
  if (!table) {
    throw new Error("Could not locate the S&P 500 constituents table.");
  }

  const rows = [];
  const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  let firstDataRow = true;
  while ((rowMatch = rowRegex.exec(table))) {
    if (firstDataRow) {
      firstDataRow = false;
      continue;
    }

    const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripTags(cell[1]));
    if (cells.length < 7) continue;

    const symbol = cells[0].toUpperCase().trim();
    const company = cells[1].trim();
    const sector = cells[2].trim();
    const subIndustry = cells[3].trim();
    const cik = cells[6].replace(/\D+/g, "").padStart(10, "0");

    if (!symbol || symbol === "SYMBOL") continue;
    rows.push({
      symbol,
      yahooSymbol: symbol.replace(/\./g, "-"),
      company,
      sector,
      subIndustry,
      cik,
    });
  }

  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return rows;
}

async function fetchUniverse() {
  const now = Date.now();
  if (universeCache.data && now - universeCache.at < CACHE_TTL_MS) {
    return universeCache.data;
  }

  const response = await fetch("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", {
    headers: {
      "User-Agent": "Mozilla/5.0 (stock-signal-lab)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) {
    throw new Error(`Universe page returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const universe = parseUniverseHtml(html);
  universeCache = { at: now, data: universe };
  return universe;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const universe = await fetchUniverse();
    const url = new URL(req.url, "http://localhost");
    const search = String(url.searchParams.get("search") || "").trim().toUpperCase();
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 500), 500));
    const filtered = search
      ? universe.filter((entry) =>
        entry.symbol.includes(search) ||
        entry.company.toUpperCase().includes(search) ||
        entry.sector.toUpperCase().includes(search)
      )
      : universe;

    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      count: universe.length,
      results: filtered.slice(0, limit),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to load S&P 500 universe." });
  }
};
