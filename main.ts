// Trend-rider bot for the make.fun cbBTC bars race (agent-fun/bars-replay/v1).
//
// Idea: a one-minute BTC series is mostly noise (a round trip costs ~26 bps in
// fee, slippage and impact), so the bot only holds CBBTC while a slow trend
// gauge says the drift is clearly up, and sits in cash otherwise. The gauge is
// the gap between a fast and a slow exponential average of closes, read as a
// ratio so it is scale-free. Entry and exit use different thresholds
// (hysteresis) so a gauge hovering near zero does not churn the account.
// A trailing stop cuts a position whose run has clearly rolled over, and a
// hard stop caps any single trade's loss. Position size is a fixed share of
// equity: no leverage games, one position, few trades.
//
// The bot is a pure function of the bars it has seen: no clock, no randomness,
// no environment, so the two graded executions agree byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Gauge spans, in bars (1 bar = 1 minute).
const FAST_SPAN = 30;
const SLOW_SPAN = 150;
// Hysteresis band on the fast/slow ratio, in bps of the slow average.
const ENTER_BPS = 10;
const EXIT_BPS = -5;
// Share of equity a buy spends (the rest stays as a cash buffer).
const BUY_SHARE_BPS = 9500;
// Stops, in bps below a reference close.
const TRAIL_BPS = 220; // below the highest close since the fill
const HARD_BPS = 350; // below the position's average cost
// Slippage cap sent with every order, in bps past the deciding close.
const SLIP_BPS = 250;

class Ema {
  #span: number;
  #seedSum = 0;
  #seedCount = 0;
  value: number | null = null;

  constructor(span: number) {
    this.#span = span;
  }

  push(x: number): number | null {
    if (this.value === null) {
      this.#seedSum += x;
      this.#seedCount += 1;
      if (this.#seedCount === this.#span) this.value = this.#seedSum / this.#span;
      return this.value;
    }
    const k = 2 / (this.#span + 1);
    this.value += k * (x - this.value);
    return this.value;
  }
}

const fast = new Ema(FAST_SPAN);
const slow = new Ema(SLOW_SPAN);

// Position bookkeeping: the entry price is the weighted price of the buy
// fills the harness reports, and the peak is the highest close since then.
// Both are kept in raw price units, the same scale as a bar's close.
let entryPrice: number | null = null;
let peakCloseSinceEntry: number | null = null;

await runBars({
  onBatch(state: BarsState, batch) {
    const orders: OrderInput[] = [];
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        // One open position at a time, so a buy fill opens a fresh entry.
        entryPrice = Number(fill.price);
        peakCloseSinceEntry = null;
      } else {
        entryPrice = null;
        peakCloseSinceEntry = null;
      }
    }
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return orders;
    const close = Number(bar.c);
    const f = fast.push(close);
    const s = slow.push(close);

    const pos = state.positions.get(SYMBOL);
    const long = pos !== undefined && pos.qty > 0n;
    if (!long) {
      peakCloseSinceEntry = null;
    } else if (peakCloseSinceEntry === null || close > peakCloseSinceEntry) {
      peakCloseSinceEntry = close;
    }

    if (state.warmingUp || f === null || s === null) return orders;

    const trendBps = ((f - s) / s) * 10_000;

    if (!long) {
      // Flat: enter only on a clearly positive trend, spending BUY_SHARE_BPS
      // of equity but never more cash than the account holds.
      if (trendBps > ENTER_BPS) {
        const budget = (state.equity * BigInt(BUY_SHARE_BPS)) / 10_000n;
        const spend = budget < state.cash ? budget : state.cash;
        const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
        if (spend >= minNotional) {
          orders.push({
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: spend,
            max_slippage_bps: SLIP_BPS,
          });
        }
      }
      return orders;
    }

    // Long: leave on a dead trend, a trailing stop or a hard stop. The entry
    // price and the closes share the raw price scale, so the stops compare
    // them directly.
    const trailHit =
      peakCloseSinceEntry !== null &&
      close < peakCloseSinceEntry * (1 - TRAIL_BPS / 10_000);
    const hardHit =
      entryPrice !== null && close < entryPrice * (1 - HARD_BPS / 10_000);
    if (trendBps < EXIT_BPS || trailHit || hardHit) {
      orders.push({
        side: 'sell',
        symbol: SYMBOL,
        qty: pos!.qty,
        max_slippage_bps: SLIP_BPS,
      });
    }
    return orders;
  },
});
