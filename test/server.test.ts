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
  const mdOrder = u.searchParams.get('mdOrder') ?? '';
  expect(await (await fetch(formUrl)).text()).toContain('id="mock-pay"'); // card page is bottable
  if (opts.cancel) {
    return fetch(`${u.origin}/pay`, { method: 'POST', body: new URLSearchParams({ mdOrder, action: 'cancel' }), redirect: 'manual' });
  }
  // step 1: submit card → 3-D Secure OTP page
  const card = new URLSearchParams({ mdOrder, action: 'pay', language: 'fr' });
  if (opts.pan) card.set('pan', opts.pan);
  expect(await (await fetch(`${u.origin}/pay`, { method: 'POST', body: card })).text()).toContain('id="otp"');
  // step 2: confirm OTP → settle + redirect
  const otp = new URLSearchParams({ mdOrder, otp: '123456', action: 'confirm', language: 'fr' });
  if (opts.pan) otp.set('pan', opts.pan);
  return fetch(`${u.origin}/pay/otp`, { method: 'POST', body: otp, redirect: 'manual' });
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
    // the decline carries the cert-card reason (what a merchant must show on the return page)
    expect(status.actionCodeDescription).toBe(testCards.stolen.reason);
    expect((status.params as Record<string, unknown>).respCode_desc).toBe(testCards.stolen.reason);
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

describe('localized page (mimics SATIM serving the page in the registered language)', () => {
  it('renders fr/en/ar (RTL for Arabic) with mock-only selectors, never SATIM real DOM', async () => {
    const { satim } = await boot();
    const cases: Array<{ lang: 'fr' | 'en' | 'ar'; needle: string; rtl: boolean }> = [
      { lang: 'fr', needle: 'Numéro de la carte', rtl: false },
      { lang: 'en', needle: 'Card number', rtl: false },
      { lang: 'ar', needle: 'رقم البطاقة', rtl: true },
    ];
    let i = 0;
    for (const { lang, needle, rtl } of cases) {
      const reg = await satim.register({ orderNumber: `L${i++}`, amount: 5000, returnUrl: 'https://shop.dz/r', udf1: 'x', language: lang });
      expect(reg.formUrl).toContain(`language=${lang}`);
      const html = await (await fetch(reg.formUrl!)).text();
      expect(html).toContain(`lang="${lang}"`);
      expect(html).toContain(`dir="${rtl ? 'rtl' : 'ltr'}"`);
      expect(html).toContain(needle);
      expect(html).toContain('id="mock-pay"'); // our mock-only selector
      expect(html).not.toContain('buttonPayment'); // we never mirror SATIM's real DOM (no botting the real page)
    }
  });
});

describe('3-D Secure OTP step', () => {
  it('rejects a wrong OTP and declines after 3 attempts (mimics SATIM lockout)', async () => {
    const { satim } = await boot();
    const reg = await satim.register({ orderNumber: 'WO', amount: 5000, returnUrl: 'https://shop.dz/ok', failUrl: 'https://shop.dz/no', udf1: 'x' });
    const u = new URL(reg.formUrl!);
    const md = u.searchParams.get('mdOrder') ?? '';
    await fetch(reg.formUrl!);
    await fetch(`${u.origin}/pay`, { method: 'POST', body: new URLSearchParams({ mdOrder: md, action: 'pay', pan: testCards.valid.pan, language: 'fr' }) });
    const wrong = (): Promise<Response> =>
      fetch(`${u.origin}/pay/otp`, { method: 'POST', body: new URLSearchParams({ mdOrder: md, pan: testCards.valid.pan, otp: '000000', action: 'confirm', language: 'fr' }), redirect: 'manual' });
    const r1 = await wrong();
    expect(r1.status).toBe(200); // re-prompted, not redirected
    expect(await r1.text()).toContain('mock-otp-error');
    await wrong(); // 2nd
    const r3 = await wrong(); // 3rd → declined
    expect(r3.status).toBe(302);
    expect(r3.headers.get('location')).toContain('/no?orderId=');
    expect((await satim.getOrderStatus(md)).orderStatus).toBe(6);
  });
});
