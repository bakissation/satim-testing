import type { SatimClient } from '@bakissation/satim';
import { toCentimes } from './amount.js';
import { type MockOrderView, MockSatimCore, type MockSatimCoreOptions, type Outcome } from './core.js';
import type { TestCard } from './cards.js';

/**
 * A drop-in {@link SatimClient} double, plus control methods to drive the
 * gateway from a test. Pass it anywhere a real SATIM client goes (e.g. to
 * `createCheckout` from `@bakissation/tasdid`).
 */
export interface MockSatim extends SatimClient {
  /** Set the outcome new orders settle to (`approved` | `declined` | `abandoned`). */
  scenario(outcome: Outcome): void;
  /** Force an order paid; `{ card }` lets the cert card decide paid vs declined. */
  pay(orderId: string, opts?: { card?: TestCard | string }): void;
  decline(orderId: string): void;
  /** Cancel/void a transaction (SATIM "annulation") ⇒ the order reads as reversed. */
  reverse(orderId: string): void;
  /** Refund a paid transaction directly at the gateway (out-of-band). */
  refundOutOfBand(orderId: string): void;
  /** Push an order past its auto-cancel window. */
  expire(orderId: string): void;
  /** Advance the mock's clock (drives expiry deterministically). */
  advanceTime(ms: number): void;
  getOrder(orderId: string): MockOrderView | undefined;
  orders(): MockOrderView[];
}

export type MockSatimOptions = MockSatimCoreOptions;

/** Create a deterministic in-memory SATIM mock that satisfies {@link SatimClient}. */
export function createMockSatim(options: MockSatimOptions = {}): MockSatim {
  const core = new MockSatimCore(options);
  return {
    register: async (params) => core.register(params),
    confirm: async (mdOrder) => core.status(mdOrder),
    getOrderStatus: async (mdOrder) => core.status(mdOrder),
    refund: async (orderId, amountDzd) => core.refund(orderId, toCentimes(amountDzd)),
    scenario: (outcome) => core.scenario(outcome),
    pay: (orderId, opts) => core.pay(orderId, opts),
    decline: (orderId) => core.decline(orderId),
    reverse: (orderId) => core.reverse(orderId),
    refundOutOfBand: (orderId) => core.refundOutOfBand(orderId),
    expire: (orderId) => core.expire(orderId),
    advanceTime: (ms) => core.advanceTime(ms),
    getOrder: (orderId) => core.getOrder(orderId),
    orders: () => core.list(),
  };
}
