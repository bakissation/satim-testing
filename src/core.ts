import type {
  ConfirmOrderResponse,
  RefundOrderResponse,
  RegisterOrderParams,
  RegisterOrderResponse,
} from '@bakissation/satim';
import { toCentimes } from './amount.js';
import { type TestCard, cardOutcome, cardReason } from './cards.js';

/** The outcome a freshly-registered order will settle to. */
export type Outcome = 'approved' | 'declined' | 'abandoned';

/** A SATIM `OrderStatus` code. 0 registered · 2 paid · 3 reversed/cancelled · 4 refunded · 6 declined. */
type SatimStatus = 0 | 2 | 3 | 4 | 6;

export interface MockOrder {
  orderId: string;
  orderNumber: string;
  amountCentimes: number;
  returnUrl: string;
  failUrl: string | null;
  outcome: Outcome;
  status: SatimStatus;
  settled: boolean;
  pan: string | null;
  approvalCode: string | null;
  /** SATIM result/decline reason (the cert-card reason for a declined card). */
  actionCodeDescription: string | null;
  refundedCentimes: number;
  registeredAtMs: number;
}

export type MockOrderView = Readonly<MockOrder>;

export interface MockSatimCoreOptions {
  /** Outcome applied to new orders (default `approved`). Change at runtime via `scenario()`. */
  scenario?: Outcome;
  /** Apply the outcome automatically on the first status check (default `true`). Off ⇒ drive manually with `pay`/`decline`/… */
  autoSettle?: boolean;
  /** Auto-cancel window — unconfirmed orders report as expired after this (default 20, SATIM's window). */
  expiresInMinutes?: number;
  /** Clock source for the mock's own expiry (default `Date.now`). `advanceTime()` works regardless. */
  now?: () => Date;
}

const DEFAULT_VALID_PAN = '6280581110007215';
const APPROVAL_CODE = '100001';
const mask = (pan: string): string => `${pan.slice(0, 4)}****${pan.slice(-4)}`;

function registerResponse(orderId: string | null, formUrl: string | null, errorCode = 0): RegisterOrderResponse {
  return {
    raw: { errorCode, orderId: orderId ?? undefined, formUrl: formUrl ?? undefined },
    errorCode,
    orderId,
    formUrl,
    isSuccessful: () => errorCode === 0 && orderId !== null,
  };
}

function confirmResponse(o: {
  errorCode?: number;
  orderStatus: number | null;
  amount?: number | null;
  depositAmount?: number | null;
  pan?: string | null;
  approvalCode?: string | null;
  orderNumber?: string | null;
  actionCodeDescription?: string | null;
  respCode?: string | null;
  respCodeDesc?: string | null;
}): ConfirmOrderResponse {
  const errorCode = o.errorCode ?? 0;
  const hasParams = o.respCode != null || o.respCodeDesc != null;
  return {
    raw: {},
    errorCode,
    orderStatus: o.orderStatus,
    amount: o.amount ?? null,
    orderNumber: o.orderNumber ?? null,
    pan: o.pan ?? null,
    actionCodeDescription: o.actionCodeDescription ?? null,
    authorizationResponseId: null,
    approvalCode: o.approvalCode ?? null,
    cardholderName: null,
    depositAmount: o.depositAmount ?? null,
    currency: '012',
    description: null,
    ip: null,
    clientId: null,
    bindingId: null,
    paymentAccountReference: null,
    params: hasParams ? { respCode: o.respCode ?? undefined, respCode_desc: o.respCodeDesc ?? undefined } : null,
    isSuccessful: () => errorCode === 0,
    isPaid: () => o.orderStatus === 2,
  };
}

function refundResponse(errorCode: number, errorMessage: string | null = null): RefundOrderResponse {
  return {
    raw: { errorCode, errorMessage: errorMessage ?? undefined },
    errorCode,
    errorMessage,
    isSuccessful: () => errorCode === 0,
  };
}

/**
 * The in-memory gateway engine: it holds orders and decides outcomes. Every
 * transport (the Tier-1 client double now, an HTTP server and a bottable
 * payment page later) is a thin wrapper over one of these — so the package
 * grows into e2e without re-deciding any behaviour.
 */
export class MockSatimCore {
  private readonly orders = new Map<string, MockOrder>();
  private seq = 0;
  private offsetMs = 0;
  private scenarioOutcome: Outcome;
  private readonly autoSettle: boolean;
  private readonly expiresInMinutes: number;
  private readonly baseNow: () => number;

  constructor(opts: MockSatimCoreOptions = {}) {
    this.scenarioOutcome = opts.scenario ?? 'approved';
    this.autoSettle = opts.autoSettle ?? true;
    this.expiresInMinutes = opts.expiresInMinutes ?? 20;
    this.baseNow = opts.now ? () => opts.now!().getTime() : () => Date.now();
  }

  // --- decision methods (the SatimClient surface) ---

  register(params: RegisterOrderParams): RegisterOrderResponse {
    const orderId = `MOCK${String(++this.seq).padStart(6, '0')}`;
    this.orders.set(orderId, {
      orderId,
      orderNumber: params.orderNumber,
      amountCentimes: toCentimes(params.amount),
      returnUrl: params.returnUrl,
      failUrl: params.failUrl ?? null,
      outcome: this.scenarioOutcome,
      status: 0,
      settled: false,
      pan: null,
      approvalCode: null,
      actionCodeDescription: null,
      refundedCentimes: 0,
      registeredAtMs: this.nowMs(),
    });
    return registerResponse(orderId, `https://mock.satim.local/pay?mdOrder=${orderId}`);
  }

  status(orderId: string): ConfirmOrderResponse {
    const o = this.orders.get(orderId);
    if (!o) return confirmResponse({ errorCode: 6, orderStatus: null }); // unregistered
    // SATIM auto-cancels an unconfirmed order after the window ⇒ unregistered (errorCode 6).
    if (o.status === 0 && !o.settled && this.isExpired(o)) {
      return confirmResponse({ errorCode: 6, orderStatus: null });
    }
    // settle the configured outcome on first observation (simulates the buyer completing on the page)
    if (this.autoSettle && o.status === 0 && !o.settled) {
      if (o.outcome === 'approved') this.applyPaid(o);
      else if (o.outcome === 'declined') this.applyDeclined(o);
      // 'abandoned' ⇒ stays registered until it expires
    }
    return this.view(o);
  }

  refund(orderId: string, amountCentimes: number): RefundOrderResponse {
    const o = this.orders.get(orderId);
    if (!o) return refundResponse(6, 'unknown order');
    if (o.status !== 2 && o.status !== 4) return refundResponse(5, 'order is not in a refundable state');
    const remaining = o.amountCentimes - o.refundedCentimes;
    if (amountCentimes <= 0 || amountCentimes > remaining) return refundResponse(5, 'refund exceeds the refundable balance');
    o.refundedCentimes += amountCentimes;
    if (o.refundedCentimes >= o.amountCentimes) o.status = 4;
    return refundResponse(0);
  }

  // --- control methods (drive the gateway from a test or the page) ---

  scenario(outcome: Outcome): void {
    this.scenarioOutcome = outcome;
  }

  /** Force an order paid. With `{ card }`, the card's outcome decides paid vs declined (cert-card fidelity). */
  pay(orderId: string, opts: { card?: TestCard | string } = {}): void {
    const o = this.must(orderId);
    if (opts.card) {
      const pan = typeof opts.card === 'string' ? opts.card : opts.card.pan;
      if (cardOutcome(pan) === 'declined') {
        o.pan = mask(pan);
        this.applyDeclined(o, cardReason(pan));
        return;
      }
      this.applyPaid(o, pan);
      return;
    }
    this.applyPaid(o);
  }

  /** Decline an order. `reason` becomes the SATIM result reason (`actionCodeDescription`/`respCode_desc`). */
  decline(orderId: string, reason?: string): void {
    this.applyDeclined(this.must(orderId), reason ?? null);
  }

  /** Cancel/void a transaction via the gateway (SATIM "annulation") ⇒ OrderStatus 3. */
  reverse(orderId: string): void {
    const o = this.must(orderId);
    o.status = 3;
    o.settled = true;
  }

  /** Refund a paid transaction directly at the gateway (out-of-band) ⇒ OrderStatus 4. */
  refundOutOfBand(orderId: string): void {
    const o = this.must(orderId);
    o.refundedCentimes = o.amountCentimes;
    o.status = 4;
  }

  /** Push an order past its auto-cancel window without waiting. */
  expire(orderId: string): void {
    this.must(orderId).registeredAtMs = this.nowMs() - this.expiryMs() - 1;
  }

  advanceTime(ms: number): void {
    this.offsetMs += ms;
  }

  getOrder(orderId: string): MockOrderView | undefined {
    const o = this.orders.get(orderId);
    return o ? { ...o } : undefined;
  }

  list(): MockOrderView[] {
    return [...this.orders.values()].map((o) => ({ ...o }));
  }

  // --- internals ---

  private nowMs(): number {
    return this.baseNow() + this.offsetMs;
  }

  private expiryMs(): number {
    return this.expiresInMinutes * 60_000;
  }

  private isExpired(o: MockOrder): boolean {
    return this.nowMs() - o.registeredAtMs > this.expiryMs();
  }

  private applyPaid(o: MockOrder, pan = DEFAULT_VALID_PAN): void {
    o.status = 2;
    o.settled = true;
    o.pan = mask(pan);
    o.approvalCode = APPROVAL_CODE;
  }

  private applyDeclined(o: MockOrder, reason: string | null = null): void {
    o.status = 6;
    o.settled = true;
    o.actionCodeDescription = reason;
  }

  /** The SATIM result reason — a specific card/event reason if set, else a status default. */
  private describe(o: MockOrder): string {
    if (o.actionCodeDescription) return o.actionCodeDescription;
    switch (o.status) {
      case 2:
        return 'Votre paiement a été accepté';
      case 6:
        return 'Votre paiement a été refusé';
      case 4:
        return 'Transaction remboursée';
      case 3:
        return 'Transaction annulée';
      default:
        return 'Commande enregistrée, non payée';
    }
  }

  private view(o: MockOrder): ConfirmOrderResponse {
    const captured = o.status === 2 || o.status === 4;
    const desc = this.describe(o);
    return confirmResponse({
      orderStatus: o.status,
      amount: o.amountCentimes,
      depositAmount: captured ? o.amountCentimes : null,
      pan: o.pan,
      approvalCode: o.approvalCode,
      orderNumber: o.orderNumber,
      actionCodeDescription: desc,
      respCode: o.status === 2 ? '00' : null,
      respCodeDesc: desc,
    });
  }

  private must(orderId: string): MockOrder {
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`mock satim: unknown order ${orderId}`);
    return o;
  }
}
