# @bakissation/satim-testing

**A deterministic mock of the SATIM (CIB/Edahabia) gateway** — a drop-in `SatimClient` double with scriptable scenarios, the official certification test cards, and SATIM's certification matrix as a ready-to-walk e2e checklist. **Plus a runnable HTTP simulator with a bottable payment page**, so a browser (Playwright/Cypress) can drive your real app end to end in CI. **No SATIM account, no network.**

[![npm](https://img.shields.io/npm/v/@bakissation/satim-testing?label=npm&color=cb3837)](https://www.npmjs.com/package/@bakissation/satim-testing)
[![CI](https://github.com/bakissation/satim-testing/actions/workflows/ci.yml/badge.svg)](https://github.com/bakissation/satim-testing/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```bash
npm i -D @bakissation/satim-testing
```

> A **test-only** tool — never wire it into production (it fabricates approvals).

## Why

SATIM's `test2.satim.dz` is remote, gated behind certification credentials, and non-deterministic — useless for unit tests/CI. `satim-testing` is a local, deterministic double of the gateway, so payments get green tests like everything else.

It satisfies the [`@bakissation/satim`](https://github.com/bakissation/satim) `SatimClient` interface, so it works **anywhere a real SATIM client goes** — swap `createSatimClient(config)` for `createMockSatim()` in your tests, whether you call SATIM **directly** or through [`@bakissation/tasdid`](https://github.com/bakissation/tasdid).

### Testing a direct `@bakissation/satim` integration

```ts
import { createMockSatim } from '@bakissation/satim-testing';

// production: const satim = createSatimClient(config)
const satim = createMockSatim();                 // ← in tests
const reg = await satim.register({ orderNumber: 'A1', amount: 5000, returnUrl: '…', udf1: 'A1' });
const status = await satim.getOrderStatus(reg.orderId!);
status.isPaid();                                 // → true   (no account, no network)
```

### Testing a `@bakissation/tasdid` checkout

```ts
import { Dinar } from '@bakissation/dinar';
import { createMockSatim } from '@bakissation/satim-testing';
import { createCheckout, createMemoryStore } from '@bakissation/tasdid';

const satim = createMockSatim();                 // default: approves
const checkout = createCheckout({ satim, store: createMemoryStore() });

const { paymentId } = await checkout.start({ orderNumber: 'A1', amount: Dinar.fromDinars(5000), returnUrl: '…' });
(await checkout.reconcile(paymentId)).status;    // → 'paid'   (no browser, no network)
```

## Steer the outcome

```ts
createMockSatim({ scenario: 'declined' });   // new orders → failed
createMockSatim({ scenario: 'abandoned' });  // buyer never pays → expires after 20 min

// or drive a specific order:
satim.scenario('approved');
satim.pay(orderId);                          // force paid
satim.pay(orderId, { card: testCards.lost });// a cert card decides paid vs declined
satim.decline(orderId);
satim.reverse(orderId);                      // cancellation (annulation)
satim.refundOutOfBand(orderId);              // refund done directly at SATIM
satim.advanceTime(21 * 60_000);              // jump past the auto-cancel window
```

## Certification matrix as your e2e base

`certChecklist` is SATIM's transaction test matrix (the cahier de recette), transcribed from the CIBWEBSATIM validation console — the same cases the SATIM team runs. Walk it as your e2e suite:

```ts
import { certChecklist, testCards, createMockSatim } from '@bakissation/satim-testing';

for (const c of certChecklist) {
  // valid card → accepted; the 13 decline cards → refused; refund → refunded; cancellation → cancelled
}
```

`testCards` are the **official** SATIM certification PANs (CIB), copied verbatim — never invented. Each maps to its `approved`/`declined` outcome.

> Passing the whole checklist locally is the strongest signal an integration will certify — but **real certification still runs on `test2.satim.dz`**, watched by SATIM via the CIBWEBLab console. A mock can't certify you.

## Run a SATIM simulator in CI (browser e2e)

The same engine also powers an **HTTP server** that speaks the real SATIM REST wire (`register.do` / `acknowledgeTransaction.do` / `refund.do`) and serves a **bottable payment page** at the `formUrl`. Point your real app's SATIM client at it and let Playwright/Cypress drive the page with a **test card** — true end-to-end, no account, no network.

### As a CLI service

```bash
npx satim-mock --port 8888
# mock SATIM listening on http://127.0.0.1:8888
#   apiBaseUrl : http://127.0.0.1:8888/payment/rest   ← point your app's SATIM client here
```

Set your app's SATIM base URL to `http://127.0.0.1:8888/payment/rest`. The page mimics SATIM's real two-step flow — **card entry → 3-D Secure OTP → redirect** — and is served in the registered `language` (`fr`/`en`/`ar`, RTL for Arabic). Mock-only selectors: `#pan`, `#expiry`, `#cvv`, `#mock-pay`, then `#otp`, `#mock-otp-confirm` (cancel: `#mock-cancel`).

```ts
// Playwright
await page.getByText('Pay').click();             // your app registers → redirects to the mock card page
await page.fill('#pan', testCards.valid.pan);    // a real cert card (declined cards → refused)
await page.click('#mock-pay');                   // → 3-D Secure OTP page
await page.fill('#otp', '123456');               // correct OTP; a wrong one re-prompts, 3 wrong → declined
await page.click('#mock-otp-confirm');           // → 302 back to your returnUrl?orderId=…
```

> The selectors are **intentionally mock-only** — they don't match SATIM's real page. Automating a live hosted payment page is against payment-industry norms, so a page-driving e2e written here passes against the simulator and **fails against the real gateway by design**. The simulator lets you prove your *integration flow* (register → redirect → OTP → return → confirm) without ever touching the real page.

### Programmatically (in-process)

```ts
import { createMockSatimServer } from '@bakissation/satim-testing/server';
import { createSatimClient } from '@bakissation/satim';

const mock = createMockSatimServer();
await mock.listen();                                       // ephemeral port
const satim = createSatimClient({ /* … */, apiBaseUrl: mock.apiBaseUrl() });
// register / drive the page / getOrderStatus exactly as in production…
await mock.close();
```

It's the same `MockSatimCore` engine, so **the full cahier de recette and all 15 cert cards pass over the wire too** — verified in `test/server.test.ts`. (Still a simulator: **real certification runs on `test2.satim.dz`**.)

## License

MIT © Abdelbaki Berkati

## Credits

Built and maintained by **Abdelbaki Berkati** — [berkati.xyz](https://berkati.xyz) · [@bakissation](https://github.com/bakissation).
