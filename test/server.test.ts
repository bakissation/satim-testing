import { describe, it, expect, afterEach } from 'vitest';
import { createSatimClient, type SatimClient } from '@bakissation/satim';
import { createCheckout, createMemoryStore } from '@bakissation/tasdid';
import { Dinar } from '@bakissation/dinar';
import { createMockSatimServer, type MockSatimServer } from '../src/server.js';
import { testCards, certChecklist } from '../src/cards.js';

let running: MockSatimServer | null = null;
afterEach(async () => {
  if (running) {
    await running.close();
    running = null;
  }
});

async function boot(): Promise<{ mock: MockSatimServer; satim: SatimClient }> {
  const mock = createMockSatimServer();
  running = mock;
  await mock.listen();
  const satim = createSatimClient({
    userName: 'mock',
    password: 'mock',
    terminalId: 'T1',
    apiBaseUrl: mock.apiBaseUrl(),
    logger: { enableDevLogging: false },
  });
  return { mock, satim };
}

/** Simulate the buyer's browser on the hosted page: GET the page, submit the card, follow the 302. */
async function payOnPage(formUrl: string, opts: { pan?: string; cancel?: boolean } = {}): Promise<Response> {
  const u = new URL(formUrl);
  const html = await (await fetch(formUrl)).text();
  expect(html).toContain('id="mock-pay"'); // the page is bottable
  const body = new URLSearchParams({ mdOrder: u.searchParams.get('mdOrder') ?? '', action: opts.cancel ? 'cancel' : 'pay' });
  if (opts.pan) body.set('pan', opts.pan);
  return fetch(`${u.origin}/pay`, { method: 'POST', body, redirect: 'manual' });
}

describe('register + hosted page + getOrderStatus (real satim client over the wire)', () => {
  it('a valid test card pays the order end to end', async () => {
    const { satim } = await boot();
    const reg = await satim.register({ orderNumber: 'CMD1', amount: 5000, returnUrl: 'https://shop.dz/return', udf1: 'x' });
    expect(reg.isSuccessful()).toBe(true);
    expect(reg.formUrl).toContain('/pay?mdOrder=');

    const redirect = await payOnPage(reg.formUrl!, { pan: testCards.valid.pan });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(`https://shop.dz/return?orderId=${reg.orderId}`);

    const status = await satim.getOrderStatus(reg.orderId!);
    expect(status.isPaid()).toBe(true);
    expect(status.orderStatus).toBe(2);
    expect(status.amount).toBe(500000); // minor units
    expect(status.pan).toBe('6280****7215');
  });

  it('a declined test card refuses the order', async () => {
    const { satim } = await boot();
    const reg = await satim.register({ orderNumber: 'CMD2', amount: 5000, returnUrl: 'https://shop.dz/ok', failUrl: 'https://shop.dz/no', udf1: 'x' });
    const redirect = await payOnPage(reg.formUrl!, { pan: testCards.stolen.pan });
    expect(redirect.headers.get('location')).toBe(`https://shop.dz/no?orderId=${reg.orderId}`);

    const status = await satim.getOrderStatus(reg.orderId!);
    expect(status.orderStatus).toBe(6);
    expect(status.isPaid()).toBe(false);
  });

  it('stays registered (status 0) until the buyer completes the page', async () => {
    const { satim } = await boot();
    const reg = await satim.register({ orderNumber: 'CMD3', amount: 5000, returnUrl: 'https://shop.dz/return', udf1: 'x' });
    const status = await satim.getOrderStatus(reg.orderId!);
    expect(status.orderStatus).toBe(0); // autoSettle off — the page drives settlement
  });

  it('refunds a paid order', async () => {
    const { satim } = await boot();
    const reg = await satim.register({ orderNumber: 'CMD4', amount: 5000, returnUrl: 'https://shop.dz/return', udf1: 'x' });
    await payOnPage(reg.formUrl!, { pan: testCards.valid.pan });
    const refund = await satim.refund(reg.orderId!, 5000);
    expect(refund.isSuccessful()).toBe(true);
    expect((await satim.getOrderStatus(reg.orderId!)).orderStatus).toBe(4);
  });
});

describe('full tasdid lifecycle over the mock server', () => {
  it('start → page → handleReturn settles the payment', async () => {
    const { mock, satim } = await boot();
    const store = createMemoryStore();
    const checkout = createCheckout({ satim, store });

    const started = await checkout.start({
      orderNumber: 'T1',
      amount: Dinar.fromDinars(5000),
      returnUrl: 'https://shop.dz/return',
    });
    expect(started.redirectUrl).toContain('/pay?mdOrder=');

    const redirect = await payOnPage(started.redirectUrl);
    const orderId = new URL(redirect.headers.get('location') ?? '').searchParams.get('orderId') ?? '';

    const result = await checkout.handleReturn({ orderId });
    expect(result.paid).toBe(true);
    expect(mock.core.getOrder(orderId)?.status).toBe(2);
  });
});

describe("SATIM cahier de recette (the CIBWEBSATIM validation matrix) over the mock server", () => {
  it('walks all 14 card scenarios from the certification console', async () => {
    const { satim } = await boot();
    let n = 0;
    let cardCases = 0;
    for (const c of certChecklist) {
      if (!c.card) continue; // remboursement / annulation handled below
      cardCases++;
      const reg = await satim.register({ orderNumber: `CC${n++}`, amount: 5000, returnUrl: 'https://shop.dz/ok', failUrl: 'https://shop.dz/no', udf1: 'x' });
      await payOnPage(reg.formUrl!, { pan: testCards[c.card].pan });
      const st = await satim.getOrderStatus(reg.orderId!);
      expect(st.orderStatus, `${c.test} (${c.card})`).toBe(c.expected === 'accepted' ? 2 : 6);
    }
    expect(cardCases).toBe(14);
  });

  it('every certification test card (15) settles to its certified outcome', async () => {
    const { satim } = await boot();
    let n = 0;
    for (const [name, card] of Object.entries(testCards)) {
      const reg = await satim.register({ orderNumber: `AC${n++}`, amount: 5000, returnUrl: 'https://shop.dz/ok', failUrl: 'https://shop.dz/no', udf1: 'x' });
      await payOnPage(reg.formUrl!, { pan: card.pan });
      const st = await satim.getOrderStatus(reg.orderId!);
      expect(st.orderStatus, `${name} → ${card.outcome}`).toBe(card.outcome === 'approved' ? 2 : 6);
    }
    expect(n).toBe(15);
  });

  it('remboursement + annulation (the two non-card rows)', async () => {
    const { mock, satim } = await boot();
    // Remboursement — refund a paid transaction via the gateway.
    const refundCase = await satim.register({ orderNumber: 'RF', amount: 5000, returnUrl: 'https://shop.dz/ok', udf1: 'x' });
    await payOnPage(refundCase.formUrl!, { pan: testCards.valid.pan });
    expect((await satim.refund(refundCase.orderId!, 5000)).isSuccessful()).toBe(true);
    expect((await satim.getOrderStatus(refundCase.orderId!)).orderStatus).toBe(4);
    // Annulation — voided via the SATIM platform interface (an out-of-band gateway action).
    const cancelCase = await satim.register({ orderNumber: 'AN', amount: 5000, returnUrl: 'https://shop.dz/ok', udf1: 'x' });
    await payOnPage(cancelCase.formUrl!, { pan: testCards.valid.pan });
    mock.core.reverse(cancelCase.orderId!);
    expect((await satim.getOrderStatus(cancelCase.orderId!)).orderStatus).toBe(3);
  });
});
