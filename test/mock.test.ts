import { describe, it, expect } from 'vitest';
import { Dinar } from '@bakissation/dinar';
import { createCheckout, createMemoryStore } from '@bakissation/tasdid';
import { createMockSatim, testCards, certChecklist, type CertExpectation } from '../src/index.js';

const order = (orderNumber: string) => ({
  orderNumber,
  amount: Dinar.fromDinars(5000),
  returnUrl: 'https://shop.dz/return',
});

describe('createMockSatim drives tasdid', () => {
  it('approved scenario → paid (with a masked PAN + approval code)', async () => {
    const satim = createMockSatim(); // default: approved
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order('OK1'));
    const r = await checkout.reconcile(paymentId);
    expect(r.status).toBe('paid');
    expect(r.satim.pan).toBe('6280****7215');
    expect(r.satim.approvalCode).toBe('100001');
  });

  it('declined scenario → failed', async () => {
    const satim = createMockSatim({ scenario: 'declined' });
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order('NO1'));
    expect((await checkout.reconcile(paymentId)).status).toBe('failed');
  });

  it('a declined cert card surfaces its reason (actionCodeDescription / respCode_desc)', async () => {
    const satim = createMockSatim({ autoSettle: false });
    const reg = await satim.register({
      orderNumber: 'NO2',
      amount: 5000,
      returnUrl: 'https://shop.dz/return',
      udf1: 'NO2',
    });
    satim.pay(reg.orderId!, { card: testCards.stolen.pan }); // buyer uses a stolen cert card
    const status = await satim.getOrderStatus(reg.orderId!);
    expect(status.orderStatus).toBe(6);
    expect(status.actionCodeDescription).toBe(testCards.stolen.reason);
    expect((status.params as Record<string, unknown>).respCode_desc).toBe(testCards.stolen.reason);
  });

  it('abandoned → stays pending, then expires past the 20-min window', async () => {
    const satim = createMockSatim({ scenario: 'abandoned' });
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order('AB1'));
    expect((await checkout.reconcile(paymentId)).status).toBe('pending');
    satim.advanceTime(21 * 60_000);
    expect((await checkout.reconcile(paymentId)).status).toBe('expired');
  });

  it('a tasdid-driven refund succeeds against the mock', async () => {
    const satim = createMockSatim();
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order('RF1'));
    await checkout.reconcile(paymentId);
    expect((await checkout.refund(paymentId)).status).toBe('refunded');
  });

  it('an out-of-band gateway refund is picked up on reconcile', async () => {
    const satim = createMockSatim();
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId, result } = await checkout.start(order('OOB1'));
    await checkout.reconcile(paymentId); // → paid
    satim.refundOutOfBand(result.orderId as string);
    expect((await checkout.reconcile(paymentId)).status).toBe('refunded');
  });
});

// The cert matrix as our e2e base — each row is a transaction SATIM runs during
// certification. Passing all of them is the strongest local signal an integration
// will certify (real cert still runs on test2.satim.dz).
describe('SATIM certification checklist (e2e)', () => {
  const want: Record<CertExpectation, string> = {
    accepted: 'paid',
    refused: 'failed',
    refunded: 'refunded',
    cancelled: 'failed', // tasdid models a reversed/cancelled transaction as failed
  };

  certChecklist.forEach((c, i) => {
    it(`${c.expected.toUpperCase()} — ${c.test}`, async () => {
      const satim = createMockSatim({ autoSettle: false });
      const checkout = createCheckout({ satim, store: createMemoryStore() });
      const { paymentId, result } = await checkout.start(order(`C${i}`));
      const orderId = result.orderId as string;

      if (c.card) {
        satim.pay(orderId, { card: testCards[c.card] });
      } else if (c.expected === 'refunded') {
        satim.pay(orderId);
        await checkout.reconcile(paymentId); // → paid
        satim.refundOutOfBand(orderId);
      } else if (c.expected === 'cancelled') {
        satim.reverse(orderId);
      }

      expect((await checkout.reconcile(paymentId)).status).toBe(want[c.expected]);
    });
  });
});
