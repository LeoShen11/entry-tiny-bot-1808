# Tiny Bot — EMA trend bot for Solana hourly bars

A small trend-following bot for the make.fun `bars-replay/v1` harness.
It reads hourly bars for SOL, WETH, JITOSOL, RAY, POPCAT, WIF and FARTCOIN
and decides when to hold each asset and when to sit in USDC.

## Strategy

- Per symbol: EMA(6) vs EMA(18) crossover on hourly closes, plus a
  12-bar momentum filter (enter only on a positive 12-bar return over +0.3%).
- Target weight 20% of equity per held symbol (harness cap is 25%).
- Per-symbol stop-loss: exit 8% below the entry cost.
- Portfolio guard: liquidate everything if equity falls 15% below its peak.
- Warmup: no trades in the first 24 bars, so the EMAs are meaningful.
- Deterministic: a pure function of the replay messages — no randomness,
  no clock, no network — so the two grading runs agree byte for byte.

## Run

The harness runs `main.ts` on Node 22 and speaks NDJSON on stdin/stdout
(`hello` / `batch` / `done` in, one `reply` per batch out).
