// Tiny Bot — trend-following bot for the make.fun bars-replay/v1 harness.
//
// Strategy (written from the protocol schema, no kit code reused):
//   Per symbol, track an EMA(6) / EMA(18) crossover on hourly closes plus a
//   12-bar momentum filter. Enter only on a confirmed uptrend (fast EMA
//   above slow EMA and 12-bar return above +1%); once in, ride the trend
//   until the fast EMA crosses back down, the 8% stop-loss trips, or the
//   portfolio drawdown guard fires — exits ignore momentum so small wiggles
//   do not churn the position in and out.
//   Target weight is 20% of equity per symbol (cap is 25%), so at most ~7
//   positions and never more than the account can fund. Exits are forced by
//   a per-symbol stop-loss 8% below the entry cost and by a portfolio-level
//   guard that liquidates everything if equity falls 15% below its peak.
//   Warmup is 24 bars so the EMAs are meaningful before the first trade.
//   Everything is a pure function of the messages received: no randomness,
//   no clock, no network, so the two grading runs agree byte for byte.
//
// Protocol: NDJSON on stdin (hello / batch / done), one {"type":"reply"}
// line on stdout per batch, echoing its seq. Prices, quantities and quote
// amounts are integer decimal strings at the scales hello announces.

import * as readline from "node:readline";

// --- Tunable strategy parameters (all plain constants, easy to audit) ---
const FAST_PERIOD = 6; // bars in the fast EMA
const SLOW_PERIOD = 18; // bars in the slow EMA
const MOMENTUM_BARS = 12; // bars in the momentum lookback
const MOMENTUM_MIN = 0.01; // need +1% over the lookback to enter
const TARGET_WEIGHT = 0.2; // 20% of equity per held symbol
const STOP_LOSS = 0.08; // exit a symbol 8% below its entry cost
const MAX_DRAWDOWN = 0.15; // liquidate all if equity is 15% off its peak
const WARMUP_BARS = 24; // bars of history before the first trade
const MAX_SLIPPAGE_BPS = 100; // 1% — generous vs the 5 bps the sim charges

interface BarMsg {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
}

interface PositionMsg {
  symbol: string;
  qty: string;
  cost_quote_units: string;
}

interface AccountMsg {
  cash_quote_units: string;
  positions: PositionMsg[];
  equity_quote_units: string;
}

interface BatchMsg {
  type: "batch";
  seq: number;
  t: number;
  bars: BarMsg[];
  fills: unknown[];
  account: AccountMsg;
}

interface HelloSymbol {
  symbol: string;
  mint: string;
  price_scale: number;
  qty_scale: number;
}

interface HelloMsg {
  type: "hello";
  protocol: string;
  seed: string;
  symbols: HelloSymbol[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  bar_interval: string;
  first_close_ms: number;
  caps: {
    max_open_positions: number;
    max_orders_per_bar: number;
    max_weight_bps: number;
    shorts: boolean;
    leverage: boolean;
  };
  fees: {
    fee_bps: number;
    slippage_bps: number;
    min_notional_quote_units: string;
  };
  latency_bars: number;
  warmup_bars?: number;
}

interface Order {
  side: "buy" | "sell";
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
}

interface SymState {
  priceScale: number;
  qtyScale: number;
  closes: number[]; // plain prices (USDC per unit), oldest first
  emaFast: number | null;
  emaSlow: number | null;
  holding: boolean; // true once entered, until the trend flips or stops out
}

const symbols = new Map<string, SymState>();
let capitalUnits = 10_000_000_000n; // 10,000 USDC at scale 6 (hello overrides)
let quoteScale = 6;
let minNotional = 1_000_000n; // 1 USDC at scale 6 (hello overrides)
let maxWeightBps = 2500;
let maxOrdersPerBar = 16;
let peakEquity = 0n;
let orderCounter = 0;

function emaUpdate(prev: number | null, price: number, period: number): number {
  const k = 2 / (period + 1);
  return prev === null ? price : price * k + prev * (1 - k);
}

function toUnits(amount: number, scale: number): bigint {
  // Convert a plain decimal amount to integer units at the given scale,
  // rounding down so we never overstate what we hold or spend.
  return BigInt(Math.floor(amount * 10 ** scale));
}

function decide(batch: BatchMsg): Order[] {
  const orders: Order[] = [];
  const equity = BigInt(batch.account.equity_quote_units);
  const cash = BigInt(batch.account.cash_quote_units);
  // Cash left to spend on this bar's buys. The v1 bot sized every buy
  // against the full cash balance, so several symbols buying on the same
  // bar overspent it and 34 orders were rejected; the budget below is
  // spent down as orders are issued, so the batch never over-commits.
  let cashLeft = cash;
  if (equity > peakEquity) peakEquity = equity;

  // Portfolio-level drawdown guard: a 15% fall from the peak liquidates all.
  const inDrawdownGuard =
    peakEquity > 0n && equity * 100n < peakEquity * BigInt(Math.round((1 - MAX_DRAWDOWN) * 100));

  const held = new Map<string, PositionMsg>();
  for (const p of batch.account.positions) held.set(p.symbol, p);

  for (const bar of batch.bars) {
    const st = symbols.get(bar.symbol);
    if (!st) continue;
    const close = Number(bar.c) / 10 ** st.priceScale;
    if (!Number.isFinite(close) || close <= 0) continue;

    st.closes.push(close);
    if (st.closes.length > 64) st.closes.shift();
    st.emaFast = emaUpdate(st.emaFast, close, FAST_PERIOD);
    st.emaSlow = emaUpdate(st.emaSlow, close, SLOW_PERIOD);

    const pos = held.get(bar.symbol);
    const heldQty = pos ? Number(pos.qty) / 10 ** st.qtyScale : 0;
    const heldValue = heldQty * close; // plain USDC
    const entryPrice =
      pos && heldQty > 0
        ? Number(pos.cost_quote_units) / 10 ** quoteScale / heldQty
        : null;

    // Stateful trend riding: enter only on a confirmed uptrend (fast EMA
    // above slow EMA and 12-bar momentum above +1%); once in, stay in until
    // the trend flips, the stop-loss trips, or the drawdown guard fires.
    // Re-deciding every bar on a small momentum wiggle churned the v1 bot
    // (155 trades, 6% win rate, -472 USDC on the dev window), so the exit
    // now ignores momentum entirely and only the entry requires it.
    const lookback = st.closes[st.closes.length - 1 - MOMENTUM_BARS];
    const momentum =
      lookback !== undefined && lookback > 0 ? (close - lookback) / lookback : -1;
    const trendUp =
      st.emaFast !== null && st.emaSlow !== null && st.emaFast > st.emaSlow;
    const stopHit = entryPrice !== null && close < entryPrice * (1 - STOP_LOSS);
    if (inDrawdownGuard || stopHit || !trendUp) {
      st.holding = false;
    } else if (
      !st.holding &&
      st.closes.length >= WARMUP_BARS &&
      momentum > MOMENTUM_MIN
    ) {
      st.holding = true;
    }
    const targetWeight = st.holding ? TARGET_WEIGHT : 0;

    const equityUsdc = Number(equity) / 10 ** quoteScale;
    const targetValue = targetWeight * equityUsdc;
    // Never target more than the harness cap (25% of equity) per symbol.
    const cappedTarget = Math.min(targetValue, (maxWeightBps / 10_000) * equityUsdc);
    const diff = cappedTarget - heldValue; // >0 buy, <0 sell

    if (diff > 0) {
      // Buy only what the cash still unspent on this bar can fund, and
      // never below the minimum notional the harness accepts.
      const cashUsdc = Number(cashLeft) / 10 ** quoteScale;
      const buyUsdc = Math.min(diff, cashUsdc);
      const notional = toUnits(buyUsdc, quoteScale);
      if (notional >= minNotional && orders.length < maxOrdersPerBar) {
        cashLeft -= notional;
        orderCounter += 1;
        orders.push({
          side: "buy",
          client_id: `b${batch.seq}-${bar.symbol}-${orderCounter}`,
          symbol: bar.symbol,
          notional_quote_units: notional.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    } else if (diff < 0 && heldQty > 0) {
      const sellUsdc = Math.min(-diff, heldValue);
      const qtyUnits = toUnits(sellUsdc / close, st.qtyScale);
      const heldUnits = BigInt(pos!.qty);
      const qty = qtyUnits > heldUnits ? heldUnits : qtyUnits;
      // Only sell if the notional clears the minimum; otherwise hold the
      // dust rather than sending an order the harness would reject.
      const notional = toUnits(Number(qty) / 10 ** st.qtyScale * close, quoteScale);
      if (qty > 0n && notional >= minNotional && orders.length < maxOrdersPerBar) {
        orderCounter += 1;
        orders.push({
          side: "sell",
          client_id: `s${batch.seq}-${bar.symbol}-${orderCounter}`,
          symbol: bar.symbol,
          qty: qty.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }
  }
  return orders;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: HelloMsg | BatchMsg | { type: "done"; seq: number };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      continue; // ignore a malformed line rather than dying mid-replay
    }
    if (msg.type === "hello") {
      const hello = msg as HelloMsg;
      capitalUnits = BigInt(hello.capital.quote_units);
      quoteScale = hello.capital.quote_scale;
      minNotional = BigInt(hello.fees.min_notional_quote_units);
      maxWeightBps = hello.caps.max_weight_bps;
      maxOrdersPerBar = hello.caps.max_orders_per_bar;
      peakEquity = capitalUnits;
      for (const s of hello.symbols) {
        symbols.set(s.symbol, {
          priceScale: s.price_scale,
          qtyScale: s.qty_scale,
          closes: [],
          emaFast: null,
          emaSlow: null,
          holding: false,
        });
      }
    } else if (msg.type === "batch") {
      const batch = msg as BatchMsg;
      const orders = decide(batch);
      const reply = JSON.stringify({ type: "reply", seq: batch.seq, orders });
      // Guard: a reply line over the protocol's 64 KiB cap would be rejected,
      // so never emit one (7 symbols can never produce that many orders).
      if (reply.length <= 65_536) process.stdout.write(reply + "\n");
      else process.stdout.write(JSON.stringify({ type: "reply", seq: batch.seq, orders: [] }) + "\n");
    } else if (msg.type === "done") {
      break;
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
