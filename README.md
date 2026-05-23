# @bakissation/satim-testing

**A deterministic in-memory mock of the SATIM (CIB/Edahabia) gateway** — a drop-in `SatimClient` double with scriptable scenarios, the official certification test cards, and SATIM's certification matrix as a ready-to-walk e2e checklist. Build and CI Algerian payment flows with **no SATIM account and no network**.

[![npm](https://img.shields.io/npm/v/@bakissation/satim-testing?label=npm&color=cb3837)](https://www.npmjs.com/package/@bakissation/satim-testing)
[![CI](https://github.com/bakissation/satim-testing/actions/workflows/ci.yml/badge.svg)](https://github.com/bakissation/satim-testing/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```bash
npm i -D @bakissation/satim-testing
```

> A **test-only** tool — never wire it into production (it fabricates approvals).

## Why

SATIM's `test2.satim.dz` is remote, gated behind certification credentials, and non-deterministic — useless for unit tests/CI. `satim-testing` is a local, deterministic double of the gateway, so payments get green tests like everything else. It satisfies the [`@bakissation/satim`](https://github.com/bakissation/satim) `SatimClient` interface, so it drops straight into [`@bakissation/tasdid`](https://github.com/bakissation/tasdid) (or any code that takes a `SatimClient`).

```ts
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

## Grows into full e2e

The package is one in-memory engine (`MockSatimCore`) with transports layered on top. Today: the **client double** above (covers all integration logic). The same engine is built to grow a local **HTTP server** (real-wire integration) and a **bottable payment page** (browser Playwright e2e) without re-deciding any behaviour — `MockSatimCore` is exported for that.

## License

MIT © Abdelbaki Berkati

## Credits

Built and maintained by **Abdelbaki Berkati** — [berkati.xyz](https://berkati.xyz) · [@bakissation](https://github.com/bakissation).
