const { parseUniverseHtml, fetchUniverse } = (() => {
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
    if (!table) throw new Error("Could not locate the S&P 500 constituents table.");

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

  const cache = { at: 0, data: null };
  async function fetchUniverse() {
    const now = Date.now();
    if (cache.data && now - cache.at < 12 * 60 * 60 * 1000) {
      return cache.data;
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
    cache.at = now;
    cache.data = universe;
    return universe;
  }

  return { parseUniverseHtml, fetchUniverse };
})();

const chartCache = new Map();
const newsCache = new Map();
const secCache = new Map();
const fedCache = { at: 0, data: null };

function normalizeTicker(input) {
  return String(input || "").trim().toUpperCase().replace(/\s+/g, "");
}

function yahooSymbol(symbol) {
  return normalizeTicker(symbol).replace(/\./g, "-");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(z) {
  if (z > 20) return 1;
  if (z < -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return 0;
  return (current / previous) - 1;
}

function mean(values) {
  const filtered = values.filter(Number.isFinite);
  if (!filtered.length) return 0;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function stddev(values) {
  const filtered = values.filter(Number.isFinite);
  if (filtered.length < 2) return 0;
  const avg = mean(filtered);
  const variance = filtered.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / filtered.length;
  return Math.sqrt(variance);
}

function smaSeries(values, period) {
  const result = [];
  for (let i = 0; i < values.length; i += 1) {
    if (i + 1 < period) {
      result.push(null);
      continue;
    }
    result.push(mean(values.slice(i + 1 - period, i + 1)));
  }
  return result;
}

function emaSeries(values, period) {
  const result = [];
  const k = 2 / (period + 1);
  let ema = null;
  for (let i = 0; i < values.length; i += 1) {
    const value = safeNumber(values[i], NaN);
    if (!Number.isFinite(value)) {
      result.push(null);
      continue;
    }

    if (ema == null) {
      if (i + 1 < period) {
        result.push(null);
        continue;
      }
      ema = mean(values.slice(i + 1 - period, i + 1));
    } else {
      ema = (value * k) + (ema * (1 - k));
    }
    result.push(ema);
  }
  return result;
}

function rsiSeries(values, period = 14) {
  const result = Array(values.length).fill(null);
  let avgGain = null;
  let avgLoss = null;
  for (let i = 1; i < values.length; i += 1) {
    const change = safeNumber(values[i], NaN) - safeNumber(values[i - 1], NaN);
    if (!Number.isFinite(change)) continue;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    if (i < period) {
      avgGain = (avgGain || 0) + gain;
      avgLoss = (avgLoss || 0) + loss;
      continue;
    }

    if (i === period) {
      avgGain = ((avgGain || 0) + gain) / period;
      avgLoss = ((avgLoss || 0) + loss) / period;
    } else {
      avgGain = ((avgGain * (period - 1)) + gain) / period;
      avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    }

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i] = 100 - (100 / (1 + rs));
  }
  return result;
}

function rollingVolatility(returns, period) {
  const result = [];
  for (let i = 0; i < returns.length; i += 1) {
    if (i + 1 < period) {
      result.push(null);
      continue;
    }
    result.push(stddev(returns.slice(i + 1 - period, i + 1)));
  }
  return result;
}

function dateKeyFromTimestamp(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function barSeriesFromYahoo(result) {
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
  return timestamps.map((ts, index) => {
    const open = safeNumber(quote.open?.[index], NaN);
    const high = safeNumber(quote.high?.[index], NaN);
    const low = safeNumber(quote.low?.[index], NaN);
    const close = safeNumber(adj[index] ?? quote.close?.[index], NaN);
    const volume = safeNumber(quote.volume?.[index], 0);
    return {
      ts,
      date: dateKeyFromTimestamp(ts),
      open,
      high,
      low,
      close,
      volume,
    };
  }).filter((bar) => Number.isFinite(bar.close));
}

async function fetchYahooChart(symbol, range, interval) {
  const key = `${symbol}|${range}|${interval}`;
  const cached = chartCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
    return cached.data;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplits`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (stock-signal-lab)",
    },
  });
  if (!response.ok) {
    throw new Error(`${symbol} chart returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const result = data?.chart?.result?.[0];
  if (!result) {
    throw new Error(`No market data found for ${symbol}.`);
  }

  const payload = {
    meta: result.meta || {},
    bars: barSeriesFromYahoo(result),
  };
  chartCache.set(key, { at: Date.now(), data: payload });
  return payload;
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml))) {
    const block = itemMatch[1];
    const title = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i)?.[1] || block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i)?.[2] || "";
    const link = block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "";
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "";
    const description = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description>([\s\S]*?)<\/description>/i)?.[1] || block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description>([\s\S]*?)<\/description>/i)?.[2] || "";
    items.push({
      title: title.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/\s+/g, " ").trim(),
      link: link.trim(),
      pubDate: pubDate.trim(),
      description: description.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/\s+/g, " ").trim(),
    });
  }
  return items;
}

function headlineTone(title) {
  const lower = String(title || "").toLowerCase();
  const positive = ["beat", "beats", "raise", "raises", "upgrade", "upgrades", "approval", "approved", "record", "strong", "growth", "surge", "jump", "rally", "buyback", "contract", "guidance", "profit", "upgrade"];
  const negative = ["miss", "misses", "cuts", "cut", "downgrade", "downgrades", "lawsuit", "probe", "investigation", "recall", "warning", "plunge", "slump", "weak", "delay", "reduction", "layoff", "sued"];
  let score = 0;
  positive.forEach((word) => { if (lower.includes(word)) score += 1; });
  negative.forEach((word) => { if (lower.includes(word)) score -= 1; });
  if (/(earnings|guidance|forecast|outlook)/.test(lower)) score *= 1.2;
  return clamp(score, -4, 4);
}

async function fetchYahooNews(symbol) {
  const key = `news:${symbol}`;
  const cached = newsCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
    return cached.data;
  }

  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (stock-signal-lab)",
    },
  });
  if (!response.ok) {
    throw new Error(`News feed returned HTTP ${response.status}`);
  }

  const xml = await response.text();
  const now = Date.now();
  const items = parseRssItems(xml).map((item) => {
    const published = Date.parse(item.pubDate);
    return {
      ...item,
      publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
      ageHours: Number.isFinite(published) ? (now - published) / 36e5 : null,
      tone: headlineTone(item.title),
    };
  });
  const burst24h = items.filter((item) => item.ageHours != null && item.ageHours <= 24).length;
  const burst7d = items.filter((item) => item.ageHours != null && item.ageHours <= 24 * 7).length;
  const avgTone = items.length ? items.reduce((sum, item) => sum + item.tone, 0) / items.length : 0;

  const data = {
    burst24h,
    burst7d,
    avgTone,
    items: items.slice(0, 8),
  };
  newsCache.set(key, { at: now, data });
  return data;
}

async function fetchSecFilings(cik) {
  const key = `sec:${cik}`;
  const cached = secCache.get(key);
  if (cached && Date.now() - cached.at < 15 * 60 * 1000) {
    return cached.data;
  }

  const padded = String(cik || "").replace(/\D+/g, "").padStart(10, "0");
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "stock-signal-lab contact@example.com",
      "Accept": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`SEC submissions returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const forms = data?.filings?.recent?.form || [];
  const dates = data?.filings?.recent?.filingDate || [];
  const accessionNumbers = data?.filings?.recent?.accessionNumber || [];
  const primaryDocs = data?.filings?.recent?.primaryDocument || [];
  const recent = [];
  for (let i = 0; i < Math.min(forms.length, dates.length); i += 1) {
    const filedAt = Date.parse(dates[i]);
    if (!Number.isFinite(filedAt)) continue;
    recent.push({
      form: forms[i],
      filedAt: new Date(filedAt).toISOString(),
      daysAgo: (Date.now() - filedAt) / 86400000,
      accessionNumber: accessionNumbers[i] || "",
      primaryDocument: primaryDocs[i] || "",
    });
  }

  const recent7d = recent.filter((item) => item.daysAgo <= 7).slice(0, 8);
  const weight = {
    "8-K": 0.55,
    "10-Q": 0.85,
    "10-K": 1,
    "4": 0.25,
    "13D": 0.45,
    "13G": 0.35,
    "S-3": 0.5,
    "S-1": 0.75,
  };
  const filingScore = recent7d.reduce((sum, item) => sum + (weight[item.form] || 0.12), 0);
  const dataOut = {
    recent7d,
    filingScore: clamp(filingScore, 0, 3),
  };
  secCache.set(key, { at: Date.now(), data: dataOut });
  return dataOut;
}

async function fetchFomcCalendar() {
  if (fedCache.data && Date.now() - fedCache.at < 12 * 60 * 60 * 1000) {
    return fedCache.data;
  }

  const response = await fetch("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", {
    headers: {
      "User-Agent": "Mozilla/5.0 (stock-signal-lab)",
    },
  });
  if (!response.ok) {
    throw new Error(`FOMC calendar returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const currentYear = new Date().getFullYear();
  const rows = [];
  const rowRegex = /<div class="row fomc-meeting"[\s\S]*?<div class="fomc-meeting__month[^"]*"><strong>([^<]+)<\/strong><\/div>[\s\S]*?<div class="fomc-meeting__date[^"]*">([^<]+)<\/div>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html))) {
    const month = rowMatch[1].trim();
    const dateRange = rowMatch[2].trim();
    const [day] = dateRange.split("-").map((entry) => entry.trim());
    const parsed = Date.parse(`${month} ${day}, ${currentYear}`);
    if (!Number.isFinite(parsed)) continue;
    rows.push({
      date: new Date(parsed).toISOString().slice(0, 10),
      range: dateRange,
      month,
    });
  }

  const data = rows.sort((a, b) => a.date.localeCompare(b.date));
  fedCache.at = Date.now();
  fedCache.data = data;
  return data;
}

function buildIndicators(bars, intraday = false) {
  const closes = bars.map((bar) => bar.close);
  const volumes = bars.map((bar) => bar.volume || 0);
  const returns1 = closes.map((close, index) => (index > 0 ? pct(close, closes[index - 1]) : 0));
  const emaFast = intraday ? emaSeries(closes, 6) : emaSeries(closes, 10);
  const emaSlow = intraday ? emaSeries(closes, 18) : emaSeries(closes, 20);
  const emaLong = intraday ? emaSeries(closes, 30) : emaSeries(closes, 50);
  const rsi = rsiSeries(closes, 14);
  const volAvg = smaSeries(volumes, intraday ? 24 : 20);
  const volVolatility = rollingVolatility(returns1, intraday ? 24 : 20);
  return {
    closes,
    volumes,
    returns1,
    emaFast,
    emaSlow,
    emaLong,
    rsi,
    volAvg,
    volVolatility,
  };
}

function featureMeans(samples) {
  const length = samples[0]?.length || 0;
  return Array.from({ length }, (_, index) => mean(samples.map((sample) => sample[index])));
}

function featureStdDevs(samples, means) {
  const length = samples[0]?.length || 0;
  return Array.from({ length }, (_, index) => {
    const values = samples.map((sample) => sample[index]);
    const sd = stddev(values);
    return sd > 0 ? sd : 1;
  });
}

function standardizeSample(sample, means, stds) {
  return sample.map((value, index) => (safeNumber(value, 0) - means[index]) / stds[index]);
}

function trainLogisticRegression(samples, labels, options = {}) {
  if (!samples.length || !labels.length) return null;
  const featureNames = options.featureNames || samples[0].map((_, index) => `f${index}`);
  const means = featureMeans(samples);
  const stds = featureStdDevs(samples, means);
  const normalized = samples.map((sample) => standardizeSample(sample, means, stds));
  const weights = Array(featureNames.length + 1).fill(0);
  const iterations = options.iterations || 260;
  const learningRate = options.learningRate || 0.07;
  const l2 = options.l2 || 0.0008;

  for (let step = 0; step < iterations; step += 1) {
    const grads = Array(weights.length).fill(0);
    for (let i = 0; i < normalized.length; i += 1) {
      const x = normalized[i];
      const y = labels[i];
      let z = weights[0];
      for (let j = 0; j < x.length; j += 1) {
        z += weights[j + 1] * x[j];
      }
      const pred = sigmoid(z);
      const error = pred - y;
      grads[0] += error;
      for (let j = 0; j < x.length; j += 1) {
        grads[j + 1] += error * x[j];
      }
    }

    for (let j = 0; j < weights.length; j += 1) {
      const regularizer = j === 0 ? 0 : l2 * weights[j];
      weights[j] -= learningRate * ((grads[j] / normalized.length) + regularizer);
    }
  }

  return {
    featureNames,
    means,
    stds,
    weights,
    iterations,
  };
}

function predictLogistic(model, sample) {
  if (!model) return 0.5;
  const normalized = standardizeSample(sample, model.means, model.stds);
  let z = model.weights[0];
  for (let i = 0; i < normalized.length; i += 1) {
    z += model.weights[i + 1] * normalized[i];
  }
  return sigmoid(z);
}

function explainModel(model, sample, topN = 5) {
  if (!model) return [];
  const normalized = standardizeSample(sample, model.means, model.stds);
  return model.featureNames
    .map((name, index) => ({
      name,
      standardized: normalized[index],
      impact: normalized[index] * model.weights[index + 1],
    }))
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, topN);
}

function buildDailySamples(tickerBars, spyBars, vixBars, horizon, threshold) {
  const samples = [];
  const labels = [];
  const snapshots = [];
  const ticker = buildIndicators(tickerBars, false);
  const spy = buildIndicators(spyBars, false);
  const vix = buildIndicators(vixBars, false);
  const minLength = Math.min(tickerBars.length, spyBars.length, vixBars.length);

  for (let i = 60; i < minLength - horizon; i += 1) {
    const bar = tickerBars[i];
    const spyBar = spyBars[i];
    const vixBar = vixBars[i];
    const prev = tickerBars[i - 1];
    if (!bar || !prev || !Number.isFinite(bar.close) || !Number.isFinite(prev.close)) continue;
    if (!spyBar || !vixBar) continue;

    const sample = [
      pct(bar.close, prev.close),
      pct(bar.close, tickerBars[i - 5]?.close || prev.close),
      pct(bar.close, tickerBars[i - 20]?.close || prev.close),
      pct(bar.open, prev.close),
      ticker.emaFast[i] && bar.close ? pct(bar.close, ticker.emaFast[i]) : 0,
      ticker.emaSlow[i] && bar.close ? pct(bar.close, ticker.emaSlow[i]) : 0,
      ticker.emaLong[i] && bar.close ? pct(bar.close, ticker.emaLong[i]) : 0,
      ticker.volAvg[i] ? (bar.volume / ticker.volAvg[i]) - 1 : 0,
      bar.high && bar.low ? (bar.high - bar.low) / bar.close : 0,
      ticker.rsi[i] ? (ticker.rsi[i] / 100) - 0.5 : 0,
      pct(spyBar.close, spyBars[i - 5]?.close || spyBars[i - 1]?.close || spyBar.close),
      pct(spyBar.close, spyBars[i - 20]?.close || spyBars[i - 1]?.close || spyBar.close),
      pct(vixBar.close, vixBars[i - 5]?.close || vixBars[i - 1]?.close || vixBar.close),
      pct(bar.close, tickerBars[i - 5]?.close || prev.close) - pct(spyBar.close, spyBars[i - 5]?.close || spyBars[i - 1]?.close || spyBar.close),
      pct(bar.close, tickerBars[i - 20]?.close || prev.close) - pct(spyBar.close, spyBars[i - 20]?.close || spyBars[i - 1]?.close || spyBar.close),
    ];
    const future = tickerBars[i + horizon];
    if (!future || !Number.isFinite(future.close)) continue;
    const forwardMove = pct(future.close, bar.close);
    samples.push(sample);
    labels.push(forwardMove > threshold ? 1 : 0);
    snapshots.push({ index: i, move: forwardMove, date: bar.date, close: bar.close });
  }

  return { samples, labels, snapshots, featureNames: [
    "1d momentum",
    "5d momentum",
    "20d momentum",
    "gap open",
    "ema fast gap",
    "ema slow gap",
    "ema long gap",
    "volume ratio",
    "range",
    "rsi",
    "spy 5d",
    "spy 20d",
    "vix 5d",
    "relative 5d",
    "relative 20d",
  ] };
}

function buildIntradaySamples(bars, horizon, threshold) {
  const samples = [];
  const labels = [];
  const snapshots = [];
  const indicators = buildIndicators(bars, true);
  const openByDate = new Map();
  bars.forEach((bar) => {
    if (!openByDate.has(bar.date) && Number.isFinite(bar.open)) {
      openByDate.set(bar.date, bar.open);
    }
  });

  for (let i = 30; i < bars.length - horizon; i += 1) {
    const bar = bars[i];
    const prev = bars[i - 1];
    if (!bar || !prev || !Number.isFinite(bar.close) || !Number.isFinite(prev.close)) continue;
    const dayOpen = openByDate.get(bar.date) || bar.open || prev.close;
    const sample = [
      pct(bar.close, prev.close),
      pct(bar.close, bars[i - 3]?.close || prev.close),
      pct(bar.close, bars[i - 6]?.close || prev.close),
      pct(bar.close, bars[i - 12]?.close || prev.close),
      indicators.emaFast[i] && bar.close ? pct(bar.close, indicators.emaFast[i]) : 0,
      indicators.emaSlow[i] && bar.close ? pct(bar.close, indicators.emaSlow[i]) : 0,
      indicators.emaLong[i] && bar.close ? pct(bar.close, indicators.emaLong[i]) : 0,
      indicators.volAvg[i] ? (bar.volume / indicators.volAvg[i]) - 1 : 0,
      bar.high && bar.low ? (bar.high - bar.low) / bar.close : 0,
      indicators.rsi[i] ? (indicators.rsi[i] / 100) - 0.5 : 0,
      pct(bar.close, dayOpen),
      indicators.volVolatility?.[i] ?? 0,
    ];
    const future = bars[i + horizon];
    if (!future || !Number.isFinite(future.close)) continue;
    const forwardMove = pct(future.close, bar.close);
    samples.push(sample);
    labels.push(forwardMove > threshold ? 1 : 0);
    snapshots.push({ index: i, move: forwardMove, date: bar.date, close: bar.close });
  }

  return { samples, labels, snapshots, featureNames: [
    "5m momentum",
    "15m momentum",
    "30m momentum",
    "60m momentum",
    "ema fast gap",
    "ema slow gap",
    "ema long gap",
    "volume ratio",
    "range",
    "rsi",
    "session momentum",
    "volatility",
  ] };
}

function latestSampleDaily(tickerBars, spyBars, vixBars) {
  const ticker = buildIndicators(tickerBars, false);
  const last = tickerBars.length - 1;
  const prev = tickerBars[last - 1];
  const spy = buildIndicators(spyBars, false);
  const vix = buildIndicators(vixBars, false);
  const spyBar = spyBars[last];
  const vixBar = vixBars[last];
  const sample = [
    pct(tickerBars[last].close, prev.close),
    pct(tickerBars[last].close, tickerBars[last - 5]?.close || prev.close),
    pct(tickerBars[last].close, tickerBars[last - 20]?.close || prev.close),
    pct(tickerBars[last].open, prev.close),
    ticker.emaFast[last] && tickerBars[last].close ? pct(tickerBars[last].close, ticker.emaFast[last]) : 0,
    ticker.emaSlow[last] && tickerBars[last].close ? pct(tickerBars[last].close, ticker.emaSlow[last]) : 0,
    ticker.emaLong[last] && tickerBars[last].close ? pct(tickerBars[last].close, ticker.emaLong[last]) : 0,
    ticker.volAvg[last] ? (tickerBars[last].volume / ticker.volAvg[last]) - 1 : 0,
    tickerBars[last].high && tickerBars[last].low ? (tickerBars[last].high - tickerBars[last].low) / tickerBars[last].close : 0,
    ticker.rsi[last] ? (ticker.rsi[last] / 100) - 0.5 : 0,
    pct(spyBar.close, spyBars[last - 5]?.close || spyBars[last - 1]?.close || spyBar.close),
    pct(spyBar.close, spyBars[last - 20]?.close || spyBars[last - 1]?.close || spyBar.close),
    pct(vixBar.close, vixBars[last - 5]?.close || vixBars[last - 1]?.close || vixBar.close),
    pct(tickerBars[last].close, tickerBars[last - 5]?.close || prev.close) - pct(spyBar.close, spyBars[last - 5]?.close || spyBars[last - 1]?.close || spyBar.close),
    pct(tickerBars[last].close, tickerBars[last - 20]?.close || prev.close) - pct(spyBar.close, spyBars[last - 20]?.close || spyBars[last - 1]?.close || spyBar.close),
  ];
  return sample;
}

function latestSampleIntraday(bars) {
  const indicators = buildIndicators(bars, true);
  const last = bars.length - 1;
  const prev = bars[last - 1];
  const openByDate = new Map();
  bars.forEach((bar) => {
    if (!openByDate.has(bar.date) && Number.isFinite(bar.open)) {
      openByDate.set(bar.date, bar.open);
    }
  });
  const dayOpen = openByDate.get(bars[last].date) || bars[last].open || prev.close;
  return [
    pct(bars[last].close, prev.close),
    pct(bars[last].close, bars[last - 3]?.close || prev.close),
    pct(bars[last].close, bars[last - 6]?.close || prev.close),
    pct(bars[last].close, bars[last - 12]?.close || prev.close),
    indicators.emaFast[last] && bars[last].close ? pct(bars[last].close, indicators.emaFast[last]) : 0,
    indicators.emaSlow[last] && bars[last].close ? pct(bars[last].close, indicators.emaSlow[last]) : 0,
    indicators.emaLong[last] && bars[last].close ? pct(bars[last].close, indicators.emaLong[last]) : 0,
    indicators.volAvg[last] ? (bars[last].volume / indicators.volAvg[last]) - 1 : 0,
    bars[last].high && bars[last].low ? (bars[last].high - bars[last].low) / bars[last].close : 0,
    indicators.rsi[last] ? (indicators.rsi[last] / 100) - 0.5 : 0,
    pct(bars[last].close, dayOpen),
    indicators.volVolatility?.[last] ?? 0,
  ];
}

function normalizeChartSeries(bars, maxPoints = 64) {
  const slice = bars.slice(-maxPoints);
  if (!slice.length) return [];
  const closes = slice.map((bar) => bar.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const spread = max - min || 1;
  return slice.map((bar) => ({
    t: bar.date,
    c: bar.close,
    n: ((bar.close - min) / spread) * 100,
  }));
}

function adjustForEvents(probability, events, horizonLabel) {
  const newsBoost = clamp((events.news.burst24h * 0.025) + (events.news.avgTone * 0.05), -0.18, 0.18);
  const secBoost = clamp(events.sec.filingScore * 0.03, 0, 0.12);
  const macroPenalty = events.macro.penalty;
  const adjusted = clamp(probability + newsBoost + secBoost - macroPenalty, 0.02, 0.98);
  const confidence = clamp(48 + Math.abs(adjusted - 0.5) * 120 - (macroPenalty * 80), 18, 99);
  return {
    probability: adjusted,
    confidence,
    eventBoost: newsBoost + secBoost - macroPenalty,
    horizonLabel,
  };
}

function summarizeNews(news) {
  return {
    burst24h: news.burst24h,
    burst7d: news.burst7d,
    avgTone: Number(news.avgTone.toFixed(2)),
    headlines: news.items.slice(0, 5).map((item) => ({
      title: item.title,
      link: item.link,
      pubDate: item.publishedAt,
      tone: item.tone,
    })),
  };
}

function summarizeSec(sec) {
  return {
    filingScore: Number(sec.filingScore.toFixed(2)),
    recentFilings: sec.recent7d.map((item) => ({
      form: item.form,
      filedAt: item.filedAt,
      daysAgo: Number(item.daysAgo.toFixed(1)),
      accessionNumber: item.accessionNumber,
      primaryDocument: item.primaryDocument,
    })),
  };
}

function summarizeMacro(fomcCalendar) {
  const today = new Date();
  const next = fomcCalendar.find((entry) => Date.parse(`${entry.date}T00:00:00Z`) >= Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (!next) {
    return { nextFomc: null, penalty: 0 };
  }
  const daysAway = Math.max(0, Math.ceil((Date.parse(`${next.date}T00:00:00Z`) - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000));
  const penalty = daysAway <= 1 ? 0.12 : daysAway <= 3 ? 0.08 : daysAway <= 7 ? 0.05 : 0;
  return {
    nextFomc: {
      date: next.date,
      daysAway,
      range: next.range,
    },
    penalty,
  };
}

async function analyzeTicker(symbolInput) {
  const symbol = normalizeTicker(symbolInput);
  if (!symbol) {
    throw new Error("Please provide a ticker symbol.");
  }

  const universe = await fetchUniverse();
  const entry = universe.find((item) => item.symbol === symbol || item.yahooSymbol === yahooSymbol(symbol));
  if (!entry) {
    throw new Error(`${symbol} is not in the current S&P 500 universe.`);
  }

  const ySymbol = entry.yahooSymbol;
  const [dailyChart, intradayChart, spyChart, vixChart, news, sec, fomc] = await Promise.all([
    fetchYahooChart(ySymbol, "2y", "1d"),
    fetchYahooChart(ySymbol, "30d", "5m"),
    fetchYahooChart("SPY", "2y", "1d"),
    fetchYahooChart("^VIX", "2y", "1d"),
    fetchYahooNews(ySymbol),
    fetchSecFilings(entry.cik),
    fetchFomcCalendar(),
  ]);

  const dailyBars = dailyChart.bars;
  const intradayBars = intradayChart.bars;
  const spyBars = spyChart.bars;
  const vixBars = vixChart.bars;

  if (dailyBars.length < 80 || intradayBars.length < 60) {
    throw new Error(`Not enough price history available for ${symbol}.`);
  }

  const dailyHorizon = buildDailySamples(dailyBars, spyBars, vixBars, 1, 0.002);
  const weeklyHorizon = buildDailySamples(dailyBars, spyBars, vixBars, 5, 0.008);
  const intradayHorizon = buildIntradaySamples(intradayBars, 3, 0.001);

  const dailyModel = trainLogisticRegression(dailyHorizon.samples, dailyHorizon.labels, {
    featureNames: dailyHorizon.featureNames,
    iterations: 220,
    learningRate: 0.075,
    l2: 0.0009,
  });
  const weeklyModel = trainLogisticRegression(weeklyHorizon.samples, weeklyHorizon.labels, {
    featureNames: weeklyHorizon.featureNames,
    iterations: 220,
    learningRate: 0.075,
    l2: 0.0009,
  });
  const intradayModel = trainLogisticRegression(intradayHorizon.samples, intradayHorizon.labels, {
    featureNames: intradayHorizon.featureNames,
    iterations: 220,
    learningRate: 0.075,
    l2: 0.0009,
  });

  const latestDaily = latestSampleDaily(dailyBars, spyBars, vixBars);
  const latestIntraday = latestSampleIntraday(intradayBars);

  const dailyBase = predictLogistic(dailyModel, latestDaily);
  const weeklyBase = predictLogistic(weeklyModel, latestDaily);
  const intradayBase = predictLogistic(intradayModel, latestIntraday);

  const macro = summarizeMacro(fomc);
  const eventBundle = {
    news: news,
    sec: sec,
    macro,
  };

  const intradayAdjusted = adjustForEvents(intradayBase, eventBundle, "intraday");
  const dailyAdjusted = adjustForEvents(dailyBase, eventBundle, "daily");
  const weeklyAdjusted = adjustForEvents(weeklyBase, eventBundle, "weekly");

  const dailyDrivers = explainModel(dailyModel, latestDaily, 6);
  const weeklyDrivers = explainModel(weeklyModel, latestDaily, 6);
  const intradayDrivers = explainModel(intradayModel, latestIntraday, 6);

  const latestClose = dailyBars.at(-1).close;
  const previousClose = dailyBars.at(-2).close;
  const changePct = pct(latestClose, previousClose) * 100;
  const sectorReturns = pct(dailyBars.at(-1).close, dailyBars.at(-6)?.close || previousClose) * 100;
  const spy5d = pct(spyBars.at(-1).close, spyBars.at(-6)?.close || spyBars.at(-2).close) * 100;
  const vix5d = pct(vixBars.at(-1).close, vixBars.at(-6)?.close || vixBars.at(-2).close) * 100;

  return {
    ticker: entry.symbol,
    yahooSymbol: entry.yahooSymbol,
    name: entry.company,
    sector: entry.sector,
    subIndustry: entry.subIndustry,
    lastPrice: latestClose,
    changePct,
    marketContext: {
      spy5d,
      vix5d,
      relative5d: sectorReturns - spy5d,
      regime: spy5d >= 0 ? "risk-on" : "risk-off",
    },
    models: {
      intraday: {
        baseProbability: intradayBase,
        probability: intradayAdjusted.probability,
        confidence: intradayAdjusted.confidence,
        eventBoost: intradayAdjusted.eventBoost,
        drivers: intradayDrivers,
        trainingSamples: intradayHorizon.samples.length,
      },
      daily: {
        baseProbability: dailyBase,
        probability: dailyAdjusted.probability,
        confidence: dailyAdjusted.confidence,
        eventBoost: dailyAdjusted.eventBoost,
        drivers: dailyDrivers,
        trainingSamples: dailyHorizon.samples.length,
      },
      weekly: {
        baseProbability: weeklyBase,
        probability: weeklyAdjusted.probability,
        confidence: weeklyAdjusted.confidence,
        eventBoost: weeklyAdjusted.eventBoost,
        drivers: weeklyDrivers,
        trainingSamples: weeklyHorizon.samples.length,
      },
    },
    events: {
      news: summarizeNews(news),
      sec: summarizeSec(sec),
      macro: {
        nextFomc: macro.nextFomc,
        penalty: macro.penalty,
      },
    },
    charts: {
      intraday: normalizeChartSeries(intradayBars, 78),
      daily: normalizeChartSeries(dailyBars, 64),
      benchmark: normalizeChartSeries(spyBars, 64),
    },
    meta: {
      updatedAt: new Date().toISOString(),
      source: "Yahoo Finance + SEC EDGAR + Federal Reserve + S&P 500 universe",
    },
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const url = new URL(req.url, "http://localhost");
  const ticker = url.searchParams.get("ticker") || "";
  try {
    const result = await analyzeTicker(ticker);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message || "Failed to analyze ticker." });
  }
};

module.exports.config = {
  maxDuration: 30,
};
