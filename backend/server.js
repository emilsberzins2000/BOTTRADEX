import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { WebSocketServer } from "ws";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { JSONFilePreset } from "lowdb/node";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);

const dataDir = path.join(__dirname, "data");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const db = await JSONFilePreset(path.join(dataDir, "db.json"), {
  users: [],
  watchlists: [],
  alerts: [],
  positions: [],
  events: []
});

const app = express();
app.use(cors());
app.use(express.json());

const server = app.listen(PORT, () => {
  console.log(`BOTTRADEX V6 backend listening on http://localhost:${PORT}`);
});
const wss = new WebSocketServer({ server });

const sockets = new Set();

wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.send(JSON.stringify({ type: "hello", message: "BOTTRADEX live socket connected" }));
  ws.on("close", () => sockets.delete(ws));
});

function loadEnv() {
  try {
    const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
    if (!existsSync(envPath)) return;
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {}
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

const DEFAULT_PAIRS = ["BTCEUR", "ETHEUR", "SOLEUR", "BNBEUR", "XRPEUR"];

async function fetchJSON(url) {
  const response = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "BOTTRADEX/6.0" }
  });
  if (!response.ok) {
    throw new Error(`Upstream ${response.status}`);
  }
  return response.json();
}

async function getTickerPrice(symbol) {
  return fetchJSON(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
}

async function getTicker24hr(symbol) {
  return fetchJSON(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
}

async function getPrices(symbols) {
  const query = encodeURIComponent(JSON.stringify(symbols));
  return fetchJSON(`https://api.binance.com/api/v3/ticker/price?symbols=${query}`);
}

async function get24h(symbols) {
  const query = encodeURIComponent(JSON.stringify(symbols));
  return fetchJSON(`https://api.binance.com/api/v3/ticker/24hr?symbols=${query}`);
}

async function getKlines(symbol, interval = "1h", limit = 120) {
  return fetchJSON(`https://api.binance.com/api/v3/uiKlines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`);
}

function scoreFrom24h(stats) {
  const pct = Number(stats?.priceChangePercent || 0);
  const volume = Number(stats?.quoteVolume || 0);
  let score = 50 + Math.max(-25, Math.min(25, pct * 2.2));
  if (volume > 2_000_000) score += 10;
  if (volume > 20_000_000) score += 10;
  score = Math.max(0, Math.min(99, Math.round(score)));
  const roundTripFeePct = 0.4;
  const bufferPct = 0.6;
  const expectedMovePct = Math.abs(pct) + Math.min(6, Math.log10(Math.max(volume, 1)) * 0.75);
  const netEdgePercent = Number((expectedMovePct - roundTripFeePct - bufferPct).toFixed(2));
  let signal = "WAIT";
  if (pct > 2 && netEdgePercent > 2) signal = "BUY";
  else if (pct < -3) signal = "AVOID";
  const reason = `24h ${pct.toFixed(2)}%, est. edge ${netEdgePercent.toFixed(2)}% after fee drag.`;
  return { score, signal, reason, expectedMovePct, roundTripFeePct, netEdgePercent };
}

function sanitizePair(input) {
  return String(input || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, users: db.data.users.length, alerts: db.data.alerts.length, pollIntervalMs: POLL_INTERVAL_MS });
});

app.post("/api/auth/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (username.length < 3 || password.length < 4) {
    return res.status(400).json({ error: "Username or password too short" });
  }
  const exists = db.data.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return res.status(409).json({ error: "Username already exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: uid("user"), username, passwordHash, createdAt: new Date().toISOString() };
  db.data.users.push(user);
  db.data.watchlists.push({ id: uid("wl"), userId: user.id, pairs: DEFAULT_PAIRS, createdAt: new Date().toISOString() });
  await db.write();
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = db.data.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get("/api/auth/me", auth, (req, res) => {
  const user = db.data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: publicUser(user) });
});

app.get("/api/market/quote/:symbol", async (req, res) => {
  try {
    const symbol = sanitizePair(req.params.symbol);
    const [price, stats] = await Promise.all([getTickerPrice(symbol), getTicker24hr(symbol)]);
    res.json({ symbol, price: Number(price.price), stats });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to fetch quote" });
  }
});

app.get("/api/market/candles/:symbol", async (req, res) => {
  try {
    const symbol = sanitizePair(req.params.symbol);
    const interval = req.query.interval || "1h";
    const limit = Math.min(500, Math.max(10, Number(req.query.limit || 120)));
    const rows = await getKlines(symbol, interval, limit);
    const candles = rows.map((k) => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: k[6]
    }));
    res.json({ symbol, interval, candles });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to fetch candles" });
  }
});

app.get("/api/scanner", async (req, res) => {
  try {
    const symbols = (req.query.symbols ? String(req.query.symbols).split(",") : DEFAULT_PAIRS).map(sanitizePair).filter(Boolean);
    const [prices, stats] = await Promise.all([getPrices(symbols), get24h(symbols)]);
    const priceMap = new Map(prices.map((p) => [p.symbol, Number(p.price)]));
    const statMap = new Map(stats.map((s) => [s.symbol, s]));
    const items = symbols.map((symbol) => {
      const price = priceMap.get(symbol);
      const day = statMap.get(symbol);
      if (price == null || !day) {
        return { symbol, price: null, change24h: null, score: 0, signal: "WAIT", reason: "Live market data unavailable for this pair." };
      }
      const engine = scoreFrom24h(day);
      return {
        symbol,
        price,
        change24h: Number(day.priceChangePercent),
        score: engine.score,
        signal: engine.signal,
        reason: engine.reason,
        quoteVolume: Number(day.quoteVolume)
      };
    }).sort((a, b) => (b.score || 0) - (a.score || 0));
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to run scanner" });
  }
});

app.get("/api/watchlist", auth, (req, res) => {
  const row = db.data.watchlists.find((w) => w.userId === req.user.id) || { pairs: DEFAULT_PAIRS };
  res.json(row);
});

app.put("/api/watchlist", auth, async (req, res) => {
  const pairs = Array.isArray(req.body.pairs) ? [...new Set(req.body.pairs.map(sanitizePair).filter(Boolean))].slice(0, 30) : [];
  let row = db.data.watchlists.find((w) => w.userId === req.user.id);
  if (!row) {
    row = { id: uid("wl"), userId: req.user.id, pairs, createdAt: new Date().toISOString() };
    db.data.watchlists.push(row);
  } else {
    row.pairs = pairs;
    row.updatedAt = new Date().toISOString();
  }
  await db.write();
  res.json(row);
});

app.get("/api/alerts", auth, (req, res) => {
  res.json({ items: db.data.alerts.filter((a) => a.userId === req.user.id) });
});

app.post("/api/alerts", auth, async (req, res) => {
  const symbol = sanitizePair(req.body.symbol);
  const targetPrice = Number(req.body.targetPrice);
  const direction = req.body.direction === "below" ? "below" : "above";
  if (!symbol || !Number.isFinite(targetPrice) || targetPrice <= 0) {
    return res.status(400).json({ error: "Invalid alert" });
  }
  const alert = {
    id: uid("alert"),
    userId: req.user.id,
    symbol,
    targetPrice,
    direction,
    status: "active",
    createdAt: new Date().toISOString()
  };
  db.data.alerts.push(alert);
  await db.write();
  res.json(alert);
});

app.delete("/api/alerts/:id", auth, async (req, res) => {
  const idx = db.data.alerts.findIndex((a) => a.id === req.params.id && a.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: "Alert not found" });
  const [removed] = db.data.alerts.splice(idx, 1);
  await db.write();
  res.json({ removed });
});

app.get("/api/portfolio", auth, (req, res) => {
  res.json({ items: db.data.positions.filter((p) => p.userId === req.user.id) });
});

app.post("/api/portfolio", auth, async (req, res) => {
  const symbol = sanitizePair(req.body.symbol);
  const amount = Number(req.body.amount);
  const entryPrice = Number(req.body.entryPrice);
  if (!symbol || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return res.status(400).json({ error: "Invalid position" });
  }
  const position = {
    id: uid("pos"),
    userId: req.user.id,
    symbol,
    amount,
    entryPrice,
    createdAt: new Date().toISOString()
  };
  db.data.positions.push(position);
  await db.write();
  res.json(position);
});

app.delete("/api/portfolio/:id", auth, async (req, res) => {
  const idx = db.data.positions.findIndex((p) => p.id === req.params.id && p.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: "Position not found" });
  const [removed] = db.data.positions.splice(idx, 1);
  await db.write();
  res.json({ removed });
});

app.get("/api/events", auth, (req, res) => {
  res.json({ items: db.data.events.filter((e) => e.userId === req.user.id).slice(-50).reverse() });
});

async function pollAlerts() {
  const active = db.data.alerts.filter((a) => a.status === "active");
  if (!active.length) return;
  const symbols = [...new Set(active.map((a) => a.symbol))];
  try {
    const prices = await getPrices(symbols);
    const priceMap = new Map(prices.map((p) => [p.symbol, Number(p.price)]));
    let changed = false;
    for (const alert of active) {
      const livePrice = priceMap.get(alert.symbol);
      if (!Number.isFinite(livePrice)) continue;
      const hit = alert.direction === "above" ? livePrice >= alert.targetPrice : livePrice <= alert.targetPrice;
      if (hit) {
        alert.status = "triggered";
        alert.triggeredAt = new Date().toISOString();
        alert.triggeredPrice = livePrice;
        db.data.events.push({
          id: uid("evt"),
          userId: alert.userId,
          type: "alert_triggered",
          title: `${alert.symbol} ${alert.direction} ${alert.targetPrice}`,
          message: `${alert.symbol} hit ${livePrice.toFixed(2)}`,
          createdAt: alert.triggeredAt
        });
        broadcast({
          type: "alert_triggered",
          userId: alert.userId,
          symbol: alert.symbol,
          livePrice,
          targetPrice: alert.targetPrice,
          direction: alert.direction,
          at: alert.triggeredAt
        });
        changed = true;
      }
    }
    if (changed) await db.write();
    broadcast({ type: "prices", items: prices });
  } catch (error) {
    console.error("pollAlerts error:", error.message);
  }
}

setInterval(() => { pollAlerts(); }, POLL_INTERVAL_MS);
pollAlerts();
