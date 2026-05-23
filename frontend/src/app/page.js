"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeSeriesScale,
  CategoryScale,
  Tooltip,
  Filler,
} from "chart.js";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeSeriesScale,
  CategoryScale,
  Tooltip,
  Filler
);

/* ------------------------------------------------------------------ */
/* Static seed data                                                   */
/* ------------------------------------------------------------------ */

const STARTING_CASH = 25000;

const SEED_STRATEGIES = [
  {
    id: "core-index",
    name: "Core Index",
    prompt: "Buy a balanced index portfolio.",
    createdAt: "2026-01-08",
    invested: 6000,
    holdings: [
      { ticker: "VTI",  name: "Vanguard Total Stock Mkt",     weight: 0.40, price: 268.42, dayChange:  0.42, kind: "ETF" },
      { ticker: "VXUS", name: "Vanguard Total International", weight: 0.20, price:  62.18, dayChange: -0.14, kind: "ETF" },
      { ticker: "BND",  name: "Vanguard Total Bond Mkt",      weight: 0.20, price:  72.91, dayChange:  0.05, kind: "ETF" },
      { ticker: "VNQ",  name: "Vanguard Real Estate",         weight: 0.10, price:  84.30, dayChange: -0.32, kind: "ETF" },
      { ticker: "GLD",  name: "SPDR Gold Shares",             weight: 0.10, price: 215.06, dayChange:  0.71, kind: "ETF" },
    ],
    drift: 0.00038,
    vol: 0.0085,
    seed: 11,
  },
  {
    id: "ai-megacaps",
    name: "AI Megacaps",
    prompt: "Concentrated bet on AI infrastructure leaders.",
    createdAt: "2026-02-14",
    invested: 4500,
    holdings: [
      { ticker: "NVDA", name: "NVIDIA",         weight: 0.30, price: 142.86, dayChange:  1.84, kind: "Stock" },
      { ticker: "MSFT", name: "Microsoft",      weight: 0.20, price: 438.20, dayChange:  0.62, kind: "Stock" },
      { ticker: "GOOGL",name: "Alphabet",       weight: 0.20, price: 178.04, dayChange: -0.21, kind: "Stock" },
      { ticker: "AMD",  name: "Advanced Micro", weight: 0.15, price: 162.55, dayChange:  2.14, kind: "Stock" },
      { ticker: "AVGO", name: "Broadcom",       weight: 0.15, price: 174.40, dayChange:  0.92, kind: "Stock" },
    ],
    drift: 0.00072,
    vol: 0.0165,
    seed: 27,
  },
  {
    id: "dividend-aristocrats",
    name: "Dividend Aristocrats",
    prompt: "Stable cashflow, 25+ years of dividend growth.",
    createdAt: "2026-03-02",
    invested: 3000,
    holdings: [
      { ticker: "NOBL", name: "ProShares S&P 500 Aristocrats", weight: 0.40, price:  98.32, dayChange:  0.08, kind: "ETF" },
      { ticker: "JNJ",  name: "Johnson & Johnson",              weight: 0.20, price: 158.40, dayChange: -0.11, kind: "Stock" },
      { ticker: "PG",   name: "Procter & Gamble",               weight: 0.15, price: 172.10, dayChange:  0.24, kind: "Stock" },
      { ticker: "KO",   name: "Coca-Cola",                      weight: 0.15, price:  68.92, dayChange:  0.06, kind: "Stock" },
      { ticker: "MMM",  name: "3M",                             weight: 0.10, price: 132.14, dayChange: -0.42, kind: "Stock" },
    ],
    drift: 0.00022,
    vol: 0.0062,
    seed: 41,
  },
];

const SEED_CHATS = {
  "core-index": [
    {
      role: "you",
      body: "Allocate $6,000 to a balanced index portfolio.",
    },
    {
      role: "taurus",
      body:
        "Built a 5-fund index core: 40% VTI, 20% VXUS, 20% BND, 10% VNQ, 10% GLD. " +
        "Annualized volatility ~9%, max drawdown ~14%. Allocated $6,000.",
    },
  ],
  "ai-megacaps": [
    {
      role: "you",
      body: "I want to be long the AI infrastructure trade. Put $4,500 in.",
    },
    {
      role: "taurus",
      body:
        "Concentrated 5-name basket weighted to compute and silicon: NVDA 30, MSFT 20, GOOGL 20, AMD 15, AVGO 15. " +
        "Higher vol (~28% ann.) but better expected drift. Funded with $4,500.",
    },
  ],
  "dividend-aristocrats": [
    {
      role: "you",
      body: "Build me something boring and cash-flowy.",
    },
    {
      role: "taurus",
      body:
        "Anchored on NOBL (40%) with four single-name aristocrats for tilt. Yield ~2.3%, " +
        "beta to S&P ~0.7. Allocated $3,000.",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Time series generation                                             */
/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Generate a 5-year daily curve starting at `invested`.
function generateCurve(invested, drift, vol, seed) {
  const rng = mulberry32(seed);
  const days = 5 * 252; // 5 years of trading days
  const points = [];
  let value = invested;
  for (let i = 0; i < days; i++) {
    const r = drift + gaussian(rng) * vol;
    value = Math.max(value * (1 + r), invested * 0.4);
    points.push(value);
  }
  return points;
}

const TIMEFRAMES = {
  "1D":  { days: 1,   sample: 1, label: "Today" },
  "1W":  { days: 5,   sample: 1, label: "Past 5 sessions" },
  "1M":  { days: 21,  sample: 1, label: "Past month" },
  "1Y":  { days: 252, sample: 2, label: "Past year" },
  "5Y":  { days: 5*252, sample: 8, label: "Past 5 years" },
};

function sliceForTimeframe(curve, tf) {
  const { days, sample } = TIMEFRAMES[tf];
  const slice = curve.slice(-days);
  const out = [];
  for (let i = 0; i < slice.length; i += sample) out.push(slice[i]);
  if (out[out.length - 1] !== slice[slice.length - 1]) out.push(slice[slice.length - 1]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Prompt → synthetic strategy                                        */
/* ------------------------------------------------------------------ */

const PROMPT_TEMPLATES = [
  {
    match: /\b(ai|artificial intelligence|machine learning|compute|gpu|semiconductor|chip)\b/i,
    build: () => ({
      name: "AI & Semis",
      holdings: [
        { ticker: "NVDA", name: "NVIDIA",      weight: 0.32, price: 142.86, dayChange: 1.84, kind: "Stock" },
        { ticker: "AMD",  name: "Advanced Micro", weight: 0.20, price: 162.55, dayChange: 2.14, kind: "Stock" },
        { ticker: "TSM",  name: "Taiwan Semi",  weight: 0.18, price: 184.20, dayChange: 0.46, kind: "Stock" },
        { ticker: "SMH",  name: "VanEck Semi ETF", weight: 0.18, price: 248.30, dayChange: 1.12, kind: "ETF" },
        { ticker: "AVGO", name: "Broadcom",     weight: 0.12, price: 174.40, dayChange: 0.92, kind: "Stock" },
      ],
      drift: 0.0008,
      vol: 0.018,
      note:
        "Tilted 50% toward design (NVDA, AMD, AVGO), 18% manufacturing (TSM), " +
        "and 18% diversified via SMH. Expect high vol — sized accordingly.",
    }),
  },
  {
    match: /\b(defense|defence|military|aerospace|weapons)\b/i,
    build: () => ({
      name: "Defense Primes",
      holdings: [
        { ticker: "LMT", name: "Lockheed Martin", weight: 0.28, price: 482.10, dayChange:  0.18, kind: "Stock" },
        { ticker: "RTX", name: "RTX Corp",        weight: 0.22, price: 124.55, dayChange: -0.04, kind: "Stock" },
        { ticker: "NOC", name: "Northrop Grumman",weight: 0.18, price: 528.40, dayChange:  0.32, kind: "Stock" },
        { ticker: "GD",  name: "General Dynamics",weight: 0.16, price: 296.10, dayChange: -0.21, kind: "Stock" },
        { ticker: "ITA", name: "iShares US Aero & Def", weight: 0.16, price: 154.80, dayChange: 0.09, kind: "ETF" },
      ],
      drift: 0.00045,
      vol: 0.0098,
      note:
        "Four primes with a basket overlay (ITA) for diversification. " +
        "Low beta to broad tech, moderate cyclicality with the defense budget.",
    }),
  },
  {
    match: /\b(bio|biotech|pharma|drug|medical|gene|genomic)\b/i,
    build: () => ({
      name: "Biotech & Pharma",
      holdings: [
        { ticker: "IBB",  name: "iShares Biotech ETF",  weight: 0.32, price: 138.20, dayChange:  0.42, kind: "ETF" },
        { ticker: "LLY",  name: "Eli Lilly",            weight: 0.22, price: 824.10, dayChange:  1.18, kind: "Stock" },
        { ticker: "VRTX", name: "Vertex Pharmaceuticals", weight: 0.18, price: 462.30, dayChange: 0.62, kind: "Stock" },
        { ticker: "REGN", name: "Regeneron",            weight: 0.16, price: 1014.80, dayChange: -0.21, kind: "Stock" },
        { ticker: "MRNA", name: "Moderna",              weight: 0.12, price:  84.55, dayChange: -1.14, kind: "Stock" },
      ],
      drift: 0.00055,
      vol: 0.0145,
      note:
        "Mixes large pharma (LLY, REGN) with growth biotech (VRTX, MRNA), " +
        "IBB as the diversified anchor. Single-name binary risk on MRNA, kept small.",
    }),
  },
  {
    match: /\b(dividend|income|cashflow|cash flow|yield)\b/i,
    build: () => ({
      name: "High Dividend",
      holdings: [
        { ticker: "SCHD", name: "Schwab US Dividend ETF", weight: 0.36, price:  82.40, dayChange:  0.05, kind: "ETF" },
        { ticker: "VYM",  name: "Vanguard High Div Yield", weight: 0.20, price: 132.90, dayChange:  0.12, kind: "ETF" },
        { ticker: "JNJ",  name: "Johnson & Johnson",       weight: 0.16, price: 158.40, dayChange: -0.11, kind: "Stock" },
        { ticker: "XOM",  name: "Exxon Mobil",             weight: 0.16, price: 118.62, dayChange:  0.74, kind: "Stock" },
        { ticker: "T",    name: "AT&T",                    weight: 0.12, price:  21.84, dayChange: -0.18, kind: "Stock" },
      ],
      drift: 0.00018,
      vol: 0.0055,
      note:
        "Anchored on SCHD/VYM for diversified yield, with three single-name " +
        "high-yielders. Trailing 12m yield ~3.4%, sub-1.0 beta.",
    }),
  },
  {
    match: /\b(energy|oil|gas|solar|renewable|clean)\b/i,
    build: () => ({
      name: "Energy Mix",
      holdings: [
        { ticker: "XLE",  name: "Energy Select Sector",   weight: 0.30, price:  94.80, dayChange:  0.42, kind: "ETF" },
        { ticker: "XOM",  name: "Exxon Mobil",            weight: 0.22, price: 118.62, dayChange:  0.74, kind: "Stock" },
        { ticker: "CVX",  name: "Chevron",                weight: 0.18, price: 162.10, dayChange:  0.31, kind: "Stock" },
        { ticker: "ICLN", name: "iShares Clean Energy",   weight: 0.18, price:  14.06, dayChange: -0.62, kind: "ETF" },
        { ticker: "ENPH", name: "Enphase Energy",         weight: 0.12, price:  78.40, dayChange: -1.46, kind: "Stock" },
      ],
      drift: 0.00038,
      vol: 0.0132,
      note:
        "70% legacy energy (XLE, XOM, CVX) for cash generation, " +
        "30% transition exposure (ICLN, ENPH) for asymmetric upside.",
    }),
  },
];

const FALLBACK_TEMPLATE = {
  name: "Custom Basket",
  holdings: [
    { ticker: "VOO",  name: "Vanguard S&P 500",     weight: 0.40, price: 528.40, dayChange:  0.22, kind: "ETF" },
    { ticker: "QQQ",  name: "Invesco QQQ",          weight: 0.25, price: 482.10, dayChange:  0.34, kind: "ETF" },
    { ticker: "IWM",  name: "iShares Russell 2000", weight: 0.15, price: 218.40, dayChange: -0.12, kind: "ETF" },
    { ticker: "EFA",  name: "iShares MSCI EAFE",    weight: 0.10, price:  82.90, dayChange:  0.08, kind: "ETF" },
    { ticker: "BND",  name: "Vanguard Total Bond",  weight: 0.10, price:  72.91, dayChange:  0.05, kind: "ETF" },
  ],
  drift: 0.00032,
  vol: 0.0090,
  note:
    "Couldn't pin a sector from the prompt — built a diversified global tilt with " +
    "a small fixed-income sleeve.",
};

function extractAmount(text) {
  // Match $4,000 / 4000 / 4k / 4.5k etc.
  const dollar = text.match(/\$\s?([\d,]+(?:\.\d+)?)/);
  if (dollar) return Math.round(parseFloat(dollar[1].replace(/,/g, "")));
  const k = text.match(/(\d+(?:\.\d+)?)\s?k\b/i);
  if (k) return Math.round(parseFloat(k[1]) * 1000);
  const plain = text.match(/\b(\d{3,6})\b/);
  if (plain) return parseInt(plain[1], 10);
  return null;
}

function buildStrategyFromPrompt(prompt, cash) {
  const template =
    PROMPT_TEMPLATES.find((t) => t.match.test(prompt))?.build() ||
    FALLBACK_TEMPLATE;

  const requested = extractAmount(prompt);
  // Cap allocation at available cash (less a tiny buffer).
  const max = Math.max(0, Math.floor(cash));
  const desired = requested ?? Math.min(3000, max);
  const invested = Math.min(desired, max);

  const id = `${template.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36).slice(-4)}`;
  const seed = Math.floor(Math.random() * 100000);

  const userMsg = { role: "you", body: prompt };
  const taurusMsg = {
    role: "taurus",
    body:
      `Built “${template.name}” with ${template.holdings.length} positions. ` +
      template.note +
      ` Allocated $${invested.toLocaleString()}.`,
  };

  return {
    strategy: {
      id,
      name: template.name,
      prompt,
      createdAt: new Date().toISOString().slice(0, 10),
      invested,
      holdings: template.holdings,
      drift: template.drift,
      vol: template.vol,
      seed,
    },
    chat: [userMsg, taurusMsg],
    invested,
  };
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

const SUGGESTIONS = [
  "Invest $4,000 in AI companies",
  "Build a defense ETF basket",
  "$3,500 in dividend payers",
  "Long biotech with $2,000",
  "Energy transition tilt",
];

export default function Home() {
  const [strategies, setStrategies] = useState(SEED_STRATEGIES);
  const [chatLogs, setChatLogs] = useState(SEED_CHATS);
  const [activeId, setActiveId] = useState(SEED_STRATEGIES[0].id);
  const [timeframe, setTimeframe] = useState("1M");
  const [prompt, setPrompt] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [cash, setCash] = useState(
    STARTING_CASH - SEED_STRATEGIES.reduce((s, x) => s + x.invested, 0)
  );

  const curves = useMemo(() => {
    const out = {};
    for (const s of strategies) {
      out[s.id] = generateCurve(s.invested, s.drift, s.vol, s.seed);
    }
    return out;
  }, [strategies]);

  const active = strategies.find((s) => s.id === activeId) || strategies[0];
  const activeCurve = curves[active.id];
  const activeChat = chatLogs[active.id] || [];

  const stats = useMemo(() => {
    if (!activeCurve) return null;
    const slice = activeCurve.slice(-TIMEFRAMES[timeframe].days);
    const start = slice[0];
    const end = slice[slice.length - 1];
    const change = end - start;
    const pct = (change / start) * 100;
    const allTime = ((activeCurve[activeCurve.length - 1] - active.invested) / active.invested) * 100;
    let peak = -Infinity;
    let dd = 0;
    for (const v of activeCurve) {
      if (v > peak) peak = v;
      const d = (peak - v) / peak;
      if (d > dd) dd = d;
    }
    return {
      end,
      change,
      pct,
      allTime,
      maxDD: dd * 100,
      vol: active.vol * Math.sqrt(252) * 100,
    };
  }, [activeCurve, timeframe, active]);

  /* ----- Chart ----- */
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeCurve) return;
    const slice = sliceForTimeframe(activeCurve, timeframe);
    const labels = slice.map((_, i) => i);
    const ctx = canvas.getContext("2d");

    const up = slice[slice.length - 1] >= slice[0];
    const color = up ? "#0a7c3e" : "#b91c1c";

    const fill = ctx.createLinearGradient(0, 0, 0, canvas.height);
    fill.addColorStop(
      0,
      up ? "rgba(10,124,62,0.18)" : "rgba(185,28,28,0.18)"
    );
    fill.addColorStop(
      1,
      up ? "rgba(10,124,62,0.00)" : "rgba(185,28,28,0.00)"
    );

    if (chartRef.current) {
      chartRef.current.destroy();
    }

    chartRef.current = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            data: slice,
            borderColor: color,
            backgroundColor: fill,
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 3,
            pointHoverBackgroundColor: color,
            pointHoverBorderColor: "#ffffff",
            pointHoverBorderWidth: 1,
            fill: true,
            tension: 0.18,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { display: false },
          y: {
            position: "right",
            grid: { color: "#eeeeec" },
            border: { display: false },
            ticks: {
              color: "#797978",
              font: { family: "JetBrains Mono, monospace", size: 10 },
              callback: (v) => "$" + Math.round(v).toLocaleString(),
              maxTicksLimit: 5,
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#0a0a0a",
            titleColor: "#ffffff",
            bodyColor: "#ffffff",
            borderColor: "#0a0a0a",
            borderWidth: 0,
            padding: 10,
            displayColors: false,
            cornerRadius: 0,
            titleFont: { family: "JetBrains Mono, monospace", size: 10, weight: 600 },
            bodyFont: { family: "JetBrains Mono, monospace", size: 11 },
            callbacks: {
              title: () => "",
              label: (ctx) => "$" + ctx.parsed.y.toFixed(2),
            },
          },
        },
      },
    });

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [activeCurve, timeframe]);

  /* ----- Submit handler ----- */

  function handleSubmit(e) {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || isTyping) return;
    if (cash <= 0) return;

    // Show the user message immediately in a placeholder strategy bucket
    // — but the new strategy itself appears after the "typing" delay.
    setPrompt("");
    setIsTyping(true);

    setTimeout(() => {
      const { strategy, chat, invested } = buildStrategyFromPrompt(text, cash);
      setStrategies((prev) => [strategy, ...prev]);
      setChatLogs((prev) => ({ ...prev, [strategy.id]: chat }));
      setCash((c) => c - invested);
      setActiveId(strategy.id);
      setTimeframe("1M");
      setIsTyping(false);
    }, 1800);
  }

  function handleChip(text) {
    setPrompt(text);
  }

  const totalInvested = strategies.reduce((s, x) => s + x.invested, 0);
  const portfolioValue =
    cash + strategies.reduce((s, x) => s + curves[x.id][curves[x.id].length - 1], 0);

  return (
    <div className="app">
      {/* ============================== SIDEBAR ============================== */}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <BullIcon />
          </span>
          <span className="brand-name">Taurus</span>
          <span className="brand-dot">v0.1</span>
        </div>

        <div className="cash">
          <div className="cash-label">Cash available</div>
          <div className="cash-value">${cash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="cash-sub">
            Invested ${totalInvested.toLocaleString()} · Total ${portfolioValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
        </div>

        <div className="section-head">
          <h3>Strategies</h3>
          <span className="count">{strategies.length.toString().padStart(2, "0")}</span>
        </div>

        <div className="strategies">
          {strategies.map((s) => {
            const curve = curves[s.id];
            const last = curve[curve.length - 1];
            const pl = ((last - s.invested) / s.invested) * 100;
            return (
              <button
                key={s.id}
                className={`strategy ${s.id === activeId ? "active" : ""}`}
                onClick={() => setActiveId(s.id)}
              >
                <div className="strategy-row1">
                  <span className="strategy-name">{s.name}</span>
                  <span className={`strategy-pl ${pl >= 0 ? "pos" : "neg"}`}>
                    {pl >= 0 ? "+" : ""}
                    {pl.toFixed(2)}%
                  </span>
                </div>
                <div className="strategy-row2">
                  <span>${s.invested.toLocaleString()} · {s.holdings.length} pos.</span>
                  <span>{s.createdAt}</span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="sidebar-foot">
          <span className="live-dot" />
          <span>MARKET OPEN · NYSE</span>
        </div>
      </aside>

      {/* ============================== MAIN ============================== */}
      <section className="main">
        {/* ----- Chat ----- */}
        <div className="chat">
          <div className="chat-head">
            <div className="chat-title">
              <h2>{active.name}</h2>
              <span>· {active.prompt}</span>
            </div>
            <div className="chat-meta">
              <div className="chat-meta-cell">
                <span>Allocated</span>
                <strong>${active.invested.toLocaleString()}</strong>
              </div>
              <div className="chat-meta-cell">
                <span>Opened</span>
                <strong>{active.createdAt}</strong>
              </div>
            </div>
          </div>

          <div className="chat-log">
            {activeChat.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="msg-role">{m.role === "you" ? "You" : "Taurus"}</div>
                <div className="msg-body">{m.body}</div>
              </div>
            ))}
            {isTyping && (
              <div className="msg taurus">
                <div className="msg-role">Taurus</div>
                <div className="msg-body">
                  <span className="typing">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              </div>
            )}
          </div>

          <form className="composer" onSubmit={handleSubmit}>
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe a strategy — e.g. invest $4,000 in AI companies"
              disabled={isTyping || cash <= 0}
            />
            <button
              type="submit"
              className="submit"
              disabled={!prompt.trim() || isTyping || cash <= 0}
            >
              {cash <= 0 ? "NO CASH" : isTyping ? "WORKING" : "BUILD"}
              <ArrowIcon />
            </button>
          </form>

          <div className="chips">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="chip"
                onClick={() => handleChip(s)}
                disabled={isTyping}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* ----- Lower split ----- */}
        <div className="lower">
          {/* Holdings */}
          <div className="panel">
            <div className="panel-head">
              <h3>Positions</h3>
              <span className="meta">{active.holdings.length} · {active.holdings.filter(h => h.kind === "ETF").length} ETF / {active.holdings.filter(h => h.kind === "Stock").length} Stock</span>
            </div>
            <div className="holdings">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Name</th>
                    <th style={{ textAlign: "right" }}>Weight</th>
                    <th style={{ textAlign: "right" }}>Value</th>
                    <th style={{ textAlign: "right" }}>Day</th>
                  </tr>
                </thead>
                <tbody>
                  {active.holdings.map((h) => {
                    const value = h.weight * active.invested;
                    return (
                      <tr key={h.ticker}>
                        <td className="ticker">{h.ticker}</td>
                        <td className="name">
                          <span className="tag">{h.kind}</span>
                          {h.name}
                        </td>
                        <td className="num">{(h.weight * 100).toFixed(0)}%</td>
                        <td className="num wide">${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                        <td className={`num ${h.dayChange >= 0 ? "pos" : "neg"}`}>
                          {h.dayChange >= 0 ? "+" : ""}
                          {h.dayChange.toFixed(2)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Performance */}
          <div className="panel">
            <div className="panel-head">
              <h3>Performance</h3>
              <span className="meta">{TIMEFRAMES[timeframe].label}</span>
            </div>

            <div className="perf-body">
              <div className="perf-head">
                <div className="perf-stat">
                  <label>Current value</label>
                  <span className="value">
                    ${stats ? stats.end.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}
                  </span>
                </div>

                <div className="timeframes">
                  {Object.keys(TIMEFRAMES).map((k) => (
                    <button
                      key={k}
                      className={k === timeframe ? "on" : ""}
                      onClick={() => setTimeframe(k)}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </div>

              <div className="perf-stats-row">
                <div className="perf-stat">
                  <label>{timeframe} change</label>
                  <span className={`value small ${stats && stats.pct >= 0 ? "pos" : "neg"}`}>
                    {stats ? (stats.pct >= 0 ? "+" : "") + stats.pct.toFixed(2) + "%" : "—"}
                  </span>
                </div>
                <div className="perf-stat">
                  <label>All time</label>
                  <span className={`value small ${stats && stats.allTime >= 0 ? "pos" : "neg"}`}>
                    {stats ? (stats.allTime >= 0 ? "+" : "") + stats.allTime.toFixed(1) + "%" : "—"}
                  </span>
                </div>
                <div className="perf-stat">
                  <label>Max DD</label>
                  <span className="value small neg">
                    {stats ? "-" + stats.maxDD.toFixed(1) + "%" : "—"}
                  </span>
                </div>
                <div className="perf-stat">
                  <label>Vol (ann.)</label>
                  <span className="value small mute">
                    {stats ? stats.vol.toFixed(1) + "%" : "—"}
                  </span>
                </div>
              </div>

              <div className="chart-wrap">
                <canvas ref={canvasRef} />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline icons                                                       */
/* ------------------------------------------------------------------ */

function BullIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6c1.5 0 3 .8 3.5 2.2" />
      <path d="M21 6c-1.5 0-3 .8-3.5 2.2" />
      <path d="M6.5 8.2c1.2 2.4 3 4 5.5 4s4.3-1.6 5.5-4" />
      <path d="M7 12.5c.4 3 2.4 6 5 6s4.6-3 5-6" />
      <circle cx="9.5" cy="11" r="0.6" fill="currentColor" />
      <circle cx="14.5" cy="11" r="0.6" fill="currentColor" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h10" />
      <path d="M9 4l4 4-4 4" />
    </svg>
  );
}
