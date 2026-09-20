/**
 * Backoff for orders the chain keeps refusing.
 *
 * A rejection classified `retryable` says nothing durable is wrong — the
 * account may be funded a moment later — so the fill's size goes back on the
 * book and the pair matches again on the very next tick. When the reason is
 * standing rather than momentary, most often `InsufficientCollateral`, that
 * loop has no exit: the matcher re-offers the same fill every tick and pays
 * gas for every rejection. Measured on the live testnet venue: 52 of 56
 * batches rejected and ~$0.49 of gas burned in minutes, by two accounts that
 * simply could not afford the trade. Nobody has to attack this; it is what an
 * ordinary underfunded account does by accident, and it scales with the
 * number of such accounts.
 *
 * So an order that has just been refused waits, a little longer each time,
 * and after enough strikes it is parked until something about it changes.
 * The clock is passed in, and nothing here touches the chain or the database.
 *
 * Both sides of a rejected fill are cooled, because `FillRejected` carries the
 * fill and the revert data, not which account was short: an order whose owner
 * cannot fund it will fail against any counterparty, so the guilty side is
 * always caught, and the innocent one waits the shortest step and returns.
 */

import type { Hex } from "viem";

export interface CooldownOptions {
  /** Wait after the first rejection; each further strike doubles it. */
  baseMs: number;
  /** Ceiling on the doubling. */
  maxMs: number;
  /** Strikes after which an order is parked rather than retried. */
  parkAfter: number;
  /**
   * How long a record outlives its wait. The strike count is the whole point
   * of the backoff, so forgetting it the moment the wait is served would hand
   * an order that fails, waits, and fails again the same two seconds forever.
   */
  forgetAfterMs: number;
}

export const DEFAULT_COOLDOWN: CooldownOptions = {
  baseMs: 2_000,
  maxMs: 60_000,
  parkAfter: 5,
  forgetAfterMs: 300_000,
};

export interface CooldownState {
  strikes: number;
  until: number;
  reason: string;
  parked: boolean;
}

export class RejectionCooldown {
  private readonly held = new Map<Hex, CooldownState>();

  constructor(private readonly o: CooldownOptions = DEFAULT_COOLDOWN) {}

  /**
   * Record a retryable rejection against an order. Returns its new state, so
   * the caller can log the moment an order is parked.
   */
  strike(orderHash: Hex, reason: string, nowMs: number): CooldownState {
    const key = orderHash.toLowerCase() as Hex;
    const previous = this.held.get(key);
    const strikes = (previous?.strikes ?? 0) + 1;
    const parked = strikes >= this.o.parkAfter;
    // 2s, 4s, 8s, … to the ceiling; a parked order waits the ceiling too, so
    // that a top-up still frees it rather than needing a restart.
    const wait = Math.min(this.o.maxMs, this.o.baseMs * 2 ** (strikes - 1));
    const state: CooldownState = { strikes, until: nowMs + wait, reason, parked };
    this.held.set(key, state);
    return state;
  }

  /** True while this order should be left out of the book. */
  blocked(orderHash: Hex, nowMs: number): boolean {
    const state = this.held.get(orderHash.toLowerCase() as Hex);
    return state !== undefined && state.until > nowMs;
  }

  /**
   * A settled fill clears the order's record: whatever was wrong is not any
   * more, and an order that trades again should not carry old strikes into
   * its next rejection.
   */
  clear(orderHash: Hex): void {
    this.held.delete(orderHash.toLowerCase() as Hex);
  }

  /** Orders held right now, for the metric and the log. */
  blockedCount(nowMs: number): number {
    let n = 0;
    for (const state of this.held.values()) if (state.until > nowMs) n += 1;
    return n;
  }

  /**
   * Forget records nothing has touched for a while. An order whose wait is
   * merely over keeps its history — that is what makes the next refusal wait
   * longer instead of restarting at two seconds — but the map must not grow
   * without bound on a busy venue.
   */
  sweep(nowMs: number): void {
    for (const [key, state] of this.held) {
      if (nowMs - state.until > this.o.forgetAfterMs) this.held.delete(key);
    }
  }

  /** Test seam. */
  stateOf(orderHash: Hex): CooldownState | undefined {
    return this.held.get(orderHash.toLowerCase() as Hex);
  }
}
