import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RegisterOrderParams } from '@bakissation/satim';
import { MockSatimCore, type MockSatimCoreOptions } from './core.js';
import { testCards } from './cards.js';

export interface MockSatimServerOptions extends MockSatimCoreOptions {
  /** Reuse an existing engine instead of creating one (drive it from your test). */
  core?: MockSatimCore;
  /** Host to bind (default `127.0.0.1`). */
  host?: string;
  /**
   * Browser-facing base URL used to build the `formUrl` the buyer is redirected to.
   * Defaults to the bound origin. Set this when the browser reaches the server at a
   * different address than the app's backend does (e.g. Docker, a CI service alias).
   */
  publicUrl?: string;
}

export interface MockSatimServer {
  /** The engine — drive it directly (`pay`/`decline`/`expire`/`advanceTime`/…) if you skip the page. */
  readonly core: MockSatimCore;
  /** The underlying Node server. */
  readonly server: Server;
  /** Start listening (ephemeral port by default); resolves with the bound origin, e.g. `http://127.0.0.1:54321`. */
  listen(port?: number): Promise<string>;
  /** The bound origin once listening. Throws if not listening. */
  url(): string;
  /** Pass this to `createSatimClient({ apiBaseUrl })` — it is `${url()}/payment/rest`. */
  apiBaseUrl(): string;
  /** Stop listening. */
  close(): Promise<void>;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/**
 * A standalone HTTP simulator of the SATIM gateway over {@link MockSatimCore}:
 * it speaks the real REST wire (`register.do`/`acknowledgeTransaction.do`/`refund.do`)
 * and serves a **bottable payment page** at the `formUrl`. Point a real
 * `@bakissation/satim` client's `apiBaseUrl` at it and drive the page with a
 * browser (Playwright/Cypress) for true end-to-end UI tests in CI — no SATIM
 * account, no network. **Test-only; never a substitute for real certification.**
 */
export function createMockSatimServer(opts: MockSatimServerOptions = {}): MockSatimServer {
  const host = opts.host ?? '127.0.0.1';
  // The page drives settlement, so disable auto-settle unless the caller opts in.
  const core = opts.core ?? new MockSatimCore({ ...opts, autoSettle: opts.autoSettle ?? false });
  let origin: string | null = null;

  function url(): string {
    if (!origin) throw new Error('mock satim server is not listening; call listen() first');
    return origin;
  }
  const formBase = (): string => opts.publicUrl ?? url();

  function readForm(req: IncomingMessage): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on('end', () => {
        resolve(Object.fromEntries(new URLSearchParams(data)));
      });
      req.on('error', reject);
    });
  }

  function sendJson(res: ServerResponse, body: Record<string, unknown>): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  // --- REST wire (what @bakissation/satim calls) ---

  function register(p: Record<string, string>): Record<string, unknown> {
    const params: RegisterOrderParams = {
      orderNumber: p.orderNumber ?? '',
      amount: Number(p.amount) / 100, // wire amount is minor units; core re-derives centimes
      returnUrl: p.returnUrl ?? '',
      udf1: 'mock',
    };
    if (p.failUrl) params.failUrl = p.failUrl;
    const reg = core.register(params);
    if (!reg.orderId) return { errorCode: 1, errorMessage: 'registration failed' };
    const lang = p.language ?? 'fr';
    const formUrl = `${formBase()}/pay?mdOrder=${encodeURIComponent(reg.orderId)}&language=${encodeURIComponent(lang)}`;
    return { errorCode: 0, orderId: reg.orderId, formUrl };
  }

  function acknowledge(p: Record<string, string>): Record<string, unknown> {
    const r = core.status(p.mdOrder ?? '');
    if (r.errorCode !== 0) return { ErrorCode: String(r.errorCode), ErrorMessage: 'order not found or expired' };
    const status = r.orderStatus;
    const desc =
      status === 2
        ? 'Votre paiement a été accepté'
        : status === 6
          ? 'Votre paiement a été refusé'
          : status === 4
            ? 'Transaction remboursée'
            : status === 3
              ? 'Transaction annulée'
              : 'Commande enregistrée, non payée';
    const out: Record<string, unknown> = {
      ErrorCode: '0',
      ErrorMessage: 'Success',
      OrderStatus: status,
      OrderNumber: r.orderNumber ?? undefined,
      Amount: r.amount ?? undefined,
      currency: r.currency ?? '012',
      actionCode: status === 2 ? 0 : undefined,
      actionCodeDescription: desc,
      params: { respCode: status === 2 ? '00' : undefined, respCode_desc: desc },
    };
    if (r.pan) out.Pan = r.pan;
    if (r.approvalCode) out.approvalCode = r.approvalCode;
    if (r.depositAmount != null) out.depositAmount = r.depositAmount;
    return out;
  }

  function refund(p: Record<string, string>): Record<string, unknown> {
    const r = core.refund(p.orderId ?? '', Math.round(Number(p.amount)));
    return r.errorCode === 0
      ? { errorCode: 0, errorMessage: 'Success' }
      : { errorCode: r.errorCode, errorMessage: r.errorMessage ?? 'refund failed' };
  }

  // --- bottable payment page (what the browser drives) ---

  function page(mdOrder: string | null): string {
    const order = mdOrder ? core.getOrder(mdOrder) : undefined;
    if (!order) {
      return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Mock SATIM</title><p id="mock-error">Unknown order</p></html>`;
    }
    const dzd = (order.amountCentimes / 100).toFixed(2);
    const cards = Object.values(testCards)
      .map((c) => `<option value="${c.pan}">${esc(c.reason)} (${c.outcome})</option>`)
      .join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock SATIM — ${esc(order.orderNumber)}</title></head>
<body>
  <main id="mock-satim" data-order-id="${esc(order.orderId)}">
    <h1>Mock SATIM payment</h1>
    <p>Order <b id="mock-order-number">${esc(order.orderNumber)}</b> — <b id="mock-amount">${dzd} DZD</b></p>
    <form id="mock-pay-form" method="POST" action="/pay">
      <input type="hidden" name="mdOrder" value="${esc(order.orderId)}">
      <label>Card number
        <input id="pan" name="pan" inputmode="numeric" autocomplete="cc-number" list="mock-cards" placeholder="6280 xxxx xxxx xxxx">
      </label>
      <datalist id="mock-cards">${cards}</datalist>
      <label>Expiry <input id="expiry" name="expiry" placeholder="MM/YYYY"></label>
      <label>CVV2 <input id="cvv" name="cvv" inputmode="numeric" placeholder="123"></label>
      <button id="mock-pay" type="submit" name="action" value="pay">Pay</button>
      <button id="mock-cancel" type="submit" name="action" value="cancel">Cancel</button>
    </form>
  </main>
</body></html>`;
  }

  function settleAndRedirect(res: ServerResponse, p: Record<string, string>): void {
    const mdOrder = p.mdOrder ?? '';
    const order = core.getOrder(mdOrder);
    if (!order) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown order');
      return;
    }
    if (p.action === 'cancel') {
      core.decline(mdOrder);
    } else if (p.pan && p.pan.trim()) {
      core.pay(mdOrder, { card: p.pan.trim() }); // the card's outcome decides paid vs declined
    } else {
      core.pay(mdOrder);
    }
    const paid = core.getOrder(mdOrder)?.status === 2;
    const base = paid ? order.returnUrl : (order.failUrl ?? order.returnUrl);
    const sep = base.includes('?') ? '&' : '?';
    res.writeHead(302, { Location: `${base}${sep}orderId=${encodeURIComponent(mdOrder)}` });
    res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const reqUrl = new URL(req.url ?? '/', `http://${host}`);
      const path = reqUrl.pathname;
      const method = req.method ?? 'GET';

      if (method === 'POST' && path === '/payment/rest/register.do') {
        sendJson(res, register(await readForm(req)));
        return;
      }
      if (method === 'POST' && path === '/payment/rest/public/acknowledgeTransaction.do') {
        sendJson(res, acknowledge(await readForm(req)));
        return;
      }
      if (method === 'POST' && path === '/payment/rest/refund.do') {
        sendJson(res, refund(await readForm(req)));
        return;
      }
      if (method === 'GET' && path === '/pay') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(reqUrl.searchParams.get('mdOrder')));
        return;
      }
      if (method === 'POST' && path === '/pay') {
        settleAndRedirect(res, await readForm(req));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errorCode: 7, errorMessage: 'not found' }));
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errorCode: 7, errorMessage: 'mock server error' }));
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  return {
    core,
    server,
    listen(port = 0): Promise<string> {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          origin = `http://${host}:${(server.address() as AddressInfo).port}`;
          resolve(origin);
        });
      });
    },
    url,
    apiBaseUrl: () => `${url()}/payment/rest`,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
