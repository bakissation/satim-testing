import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RegisterOrderParams } from '@bakissation/satim';
import { MockSatimCore, type MockSatimCoreOptions, type MockOrderView } from './core.js';
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
  /** The OTP the 3-D Secure step accepts (default `123456`). 3 wrong attempts ⇒ declined. */
  otp?: string;
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

type Lang = 'fr' | 'en' | 'ar';
const langOf = (v: string | null): Lang => (v === 'en' || v === 'ar' ? v : 'fr');

interface PageStrings {
  title: string; amount: string; card: string; holder: string; expiry: string; cvv: string;
  pay: string; cancel: string; secure: string; order: string; sim: string; cards: string; notFound: string;
  otpTitle: string; otpHint: string; otpLabel: string; confirm: string; otpWrong: string; otpTriesLeft: string;
}
/** SATIM serves the hosted page in the registered language (fr/en/ar; ar is RTL). We mimic that behaviour. */
const STRINGS: Record<Lang, PageStrings> = {
  fr: { title: 'Paiement', amount: 'Montant', card: 'Numéro de la carte', holder: 'Nom du détenteur', expiry: "Date d'expiration", cvv: 'Code de sûreté', pay: 'Payer', cancel: 'Annuler', secure: 'Paiement 100% sécurisé · 3-D Secure', order: 'Commande', sim: 'SIMULATEUR · environnement de test — aucun paiement réel', cards: 'Cartes de test (certification)', notFound: 'Commande introuvable', otpTitle: 'Authentification 3-D Secure', otpHint: 'Un code de confirmation a été envoyé à votre téléphone.', otpLabel: 'Code de confirmation (OTP)', confirm: 'Confirmer', otpWrong: 'Code incorrect', otpTriesLeft: 'tentative(s) restante(s)' },
  en: { title: 'Payment', amount: 'Amount', card: 'Card number', holder: 'Cardholder name', expiry: 'Expiry date', cvv: 'Security code', pay: 'Pay', cancel: 'Cancel', secure: '100% secure payment · 3-D Secure', order: 'Order', sim: 'SIMULATOR · test environment — no real payment', cards: 'Test cards (certification)', notFound: 'Order not found', otpTitle: '3-D Secure authentication', otpHint: 'A confirmation code was sent to your phone.', otpLabel: 'Confirmation code (OTP)', confirm: 'Confirm', otpWrong: 'Incorrect code', otpTriesLeft: 'attempt(s) left' },
  ar: { title: 'الدفع', amount: 'المبلغ', card: 'رقم البطاقة', holder: 'اسم حامل البطاقة', expiry: 'تاريخ الانتهاء', cvv: 'رمز الأمان', pay: 'ادفع', cancel: 'إلغاء', secure: 'دفع آمن 100٪ · 3-D Secure', order: 'الطلب', sim: 'محاكٍ · بيئة اختبار — لا يوجد دفع حقيقي', cards: 'بطاقات الاختبار (الاعتماد)', notFound: 'الطلب غير موجود', otpTitle: 'مصادقة 3-D Secure', otpHint: 'تم إرسال رمز التأكيد إلى هاتفك.', otpLabel: 'رمز التأكيد (OTP)', confirm: 'تأكيد', otpWrong: 'رمز غير صحيح', otpTriesLeft: 'محاولة متبقية' },
};

// Our own mock-only styling + selectors — deliberately NOT SATIM's real DOM, so a
// page-driving bot works against the simulator and fails against the real gateway
// (SATIM forbids automating its hosted page). The wire below is the faithful part.
const PAGE_CSS = `:root{--cib:#0a7d4d;--gold:#d4a017;--ink:#1a2330;--muted:#6b7280;--line:#e5e7eb;--bg:#eef1f4;--danger:#b91c1c}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink);display:flex;flex-direction:column;align-items:center;min-height:100vh;padding:16px}
.sim-banner{width:100%;max-width:420px;background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;border-radius:8px;padding:8px 12px;font-size:13px;font-weight:600;text-align:center;margin-bottom:14px}
.card{width:100%;max-width:420px;background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 30px rgba(16,24,40,.08);padding:22px;margin:auto 0}
.brand{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:16px}
.logo{font-weight:800;letter-spacing:.5px;font-size:22px;color:var(--cib)}.schemes{font-size:12px;color:var(--muted);font-weight:600}.schemes b{color:var(--gold)}
.amount{text-align:center;margin-bottom:18px}.amt-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.amt{font-size:30px;font-weight:800}.cur{font-size:15px;color:var(--muted);font-weight:600}.order{font-size:13px;color:var(--muted);margin-top:4px}
.form{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px}.row .field{flex:1}
.field{display:flex;flex-direction:column;gap:4px}.field span{font-size:12px;color:var(--muted);font-weight:600}
input{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:9px;outline:0;width:100%}
input:focus{border-color:var(--cib);box-shadow:0 0 0 3px rgba(10,125,77,.12)}
.actions{display:flex;gap:10px;margin-top:6px}.btn{flex:1;font:inherit;font-weight:700;padding:12px;border:0;border-radius:10px;cursor:pointer}
.pay{background:var(--cib);color:#fff}.pay:hover{filter:brightness(1.05)}.cancel{background:#f3f4f6;color:var(--ink)}
.help{margin-top:16px;font-size:12px;color:var(--muted)}.help summary{cursor:pointer;font-weight:600}
.help ul{margin:8px 0 0;padding-inline-start:16px;max-height:150px;overflow:auto}.help code{font-family:ui-monospace,Menlo,monospace}.help em{color:var(--cib);font-style:normal}
.secure{display:flex;align-items:center;justify-content:center;gap:6px;font-size:12px;color:var(--muted);margin-top:10px}
.foot{margin-top:16px;text-align:center;font-size:11px;color:var(--muted)}.error{text-align:center;color:var(--danger);font-weight:600;margin:0}`;

/**
 * A standalone HTTP simulator of the SATIM gateway over {@link MockSatimCore}.
 * The **REST wire** (`register.do`/`acknowledgeTransaction.do`/`refund.do`) and the
 * redirect flow are faithful to the real gateway, including localizing the page by
 * the registered `language` (fr/en/ar). The **payment page is intentionally our own**
 * (mock-only selectors), so a page-driving bot passes here and fails against real
 * SATIM — we don't enable automating the real hosted page. **Test-only.**
 */
export function createMockSatimServer(opts: MockSatimServerOptions = {}): MockSatimServer {
  const host = opts.host ?? '127.0.0.1';
  const core = opts.core ?? new MockSatimCore({ ...opts, autoSettle: opts.autoSettle ?? false });
  const correctOtp = opts.otp ?? '123456';
  const otpAttempts = new Map<string, number>();
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

  // --- REST wire (faithful — what @bakissation/satim calls) ---

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
    const lang = langOf(p.language ?? null);
    const formUrl = `${formBase()}/pay?mdOrder=${encodeURIComponent(reg.orderId)}&language=${lang}`;
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

  // --- our own bottable payment page (mock-only selectors), localized fr/en/ar ---

  function shell(title: string, lang: Lang, inner: string): string {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>${inner}</body></html>`;
  }

  function page(mdOrder: string | null, language: string | null): string {
    const lang = langOf(language);
    const t = STRINGS[lang];
    const order = mdOrder ? core.getOrder(mdOrder) : undefined;
    if (!order) {
      return shell(t.title, lang, `<main class="card"><p id="mock-error" class="error">${t.notFound}</p></main>`);
    }
    const dzd = (order.amountCentimes / 100).toFixed(2);
    const oid = esc(order.orderId);
    const cards = Object.values(testCards)
      .map((c) => `<option value="${c.pan}">${esc(c.reason)} (${c.outcome})</option>`)
      .join('');
    const help = Object.values(testCards)
      .map((c) => `<li><code>${c.pan}</code> — ${esc(c.reason)} <em>${c.outcome}</em></li>`)
      .join('');
    return shell(
      `${t.title} — ${order.orderNumber}`,
      lang,
      `<div class="sim-banner">${t.sim} · <code>@bakissation/satim-testing</code></div>
<main id="mock-satim" data-order-id="${oid}" data-lang="${lang}" class="card">
  <header class="brand"><span class="logo">SATIM</span><span class="schemes">CIB · <b>Edahabia</b></span></header>
  <section class="amount">
    <div class="amt-label">${t.amount}</div>
    <div class="amt"><span id="mock-amount">${dzd}</span> <span class="cur">DZD</span></div>
    <div class="order">${t.order} <b id="mock-order-number">${esc(order.orderNumber)}</b></div>
  </section>
  <form id="mock-pay-form" method="POST" action="/pay" class="form">
    <input type="hidden" name="mdOrder" value="${oid}">
    <input type="hidden" name="language" value="${lang}">
    <label class="field"><span>${t.card}</span>
      <input id="pan" name="pan" inputmode="numeric" dir="ltr" autocomplete="cc-number" list="mock-cards" maxlength="19" placeholder="6280 0000 0000 0000" required></label>
    <datalist id="mock-cards">${cards}</datalist>
    <label class="field"><span>${t.holder}</span><input id="holder" name="holder" autocomplete="cc-name"></label>
    <div class="row">
      <label class="field"><span>${t.expiry}</span><input id="expiry" name="expiry" dir="ltr" inputmode="numeric" placeholder="MM/AAAA"></label>
      <label class="field"><span>${t.cvv}</span><input id="cvv" name="cvv" type="password" dir="ltr" inputmode="numeric" maxlength="4" placeholder="•••"></label>
    </div>
    <div class="actions">
      <button id="mock-pay" type="submit" name="action" value="pay" class="btn pay">${t.pay} ${dzd} DZD</button>
      <button id="mock-cancel" type="submit" name="action" value="cancel" class="btn cancel">${t.cancel}</button>
    </div>
    <div class="secure">🔒 ${t.secure}</div>
  </form>
  <details class="help"><summary>${t.cards}</summary><ul>${help}</ul></details>
  <footer class="foot">Mock SATIM gateway · <code>@bakissation/satim-testing</code></footer>
</main>`,
    );
  }

  /** The 3-D Secure / OTP step — mimics SATIM showing an OTP page after card entry. */
  function otpPage(order: MockOrderView, pan: string, lang: Lang, remaining?: number): string {
    const t = STRINGS[lang];
    const oid = esc(order.orderId);
    const err = remaining === undefined ? '' : `<p id="mock-otp-error" class="error">${t.otpWrong} — ${remaining} ${t.otpTriesLeft}</p>`;
    return shell(
      `${t.otpTitle} — ${order.orderNumber}`,
      lang,
      `<div class="sim-banner">${t.sim} · <code>@bakissation/satim-testing</code></div>
<main id="mock-otp" data-order-id="${oid}" data-lang="${lang}" class="card">
  <header class="brand"><span class="logo">SATIM</span><span class="schemes">3-D Secure</span></header>
  <section class="amount"><div class="amt-label">${t.otpTitle}</div><div class="order">${t.otpHint}</div></section>
  ${err}
  <form id="mock-otp-form" method="POST" action="/pay/otp" class="form">
    <input type="hidden" name="mdOrder" value="${oid}">
    <input type="hidden" name="pan" value="${esc(pan)}">
    <input type="hidden" name="language" value="${lang}">
    <label class="field"><span>${t.otpLabel}</span>
      <input id="otp" name="otp" inputmode="numeric" dir="ltr" autocomplete="one-time-code" maxlength="6" placeholder="••••••"></label>
    <div class="actions">
      <button id="mock-otp-confirm" type="submit" name="action" value="confirm" class="btn pay">${t.confirm}</button>
      <button id="mock-otp-cancel" type="submit" name="action" value="cancel" class="btn cancel">${t.cancel}</button>
    </div>
    <div class="secure">🔒 ${t.secure}</div>
  </form>
</main>`,
    );
  }

  function redirectFor(res: ServerResponse, mdOrder: string): void {
    const order = core.getOrder(mdOrder);
    if (!order) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown order');
      return;
    }
    const base = order.status === 2 ? order.returnUrl : (order.failUrl ?? order.returnUrl);
    const sep = base.includes('?') ? '&' : '?';
    res.writeHead(302, { Location: `${base}${sep}orderId=${encodeURIComponent(mdOrder)}` });
    res.end();
  }

  // Step 1: card submitted → 3-D Secure OTP page (or Cancel → declined + redirect).
  function handlePay(res: ServerResponse, p: Record<string, string>): void {
    const mdOrder = p.mdOrder ?? '';
    const order = core.getOrder(mdOrder);
    if (!order) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown order');
      return;
    }
    if (p.action === 'cancel') {
      core.decline(mdOrder);
      redirectFor(res, mdOrder);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(otpPage(order, (p.pan ?? '').trim(), langOf(p.language ?? null)));
  }

  // Step 2: OTP confirmed → settle by the card's outcome → redirect (mimics 3-D Secure auth).
  function handleOtp(res: ServerResponse, p: Record<string, string>): void {
    const mdOrder = p.mdOrder ?? '';
    const order = core.getOrder(mdOrder);
    if (!order) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown order');
      return;
    }
    if (p.action === 'cancel') {
      otpAttempts.delete(mdOrder);
      core.decline(mdOrder);
      redirectFor(res, mdOrder);
      return;
    }
    if ((p.otp ?? '').trim() !== correctOtp) {
      const tries = (otpAttempts.get(mdOrder) ?? 0) + 1;
      if (tries >= 3) {
        otpAttempts.delete(mdOrder);
        core.decline(mdOrder); // too many wrong OTPs ⇒ declined (mimics SATIM's lockout)
        redirectFor(res, mdOrder);
        return;
      }
      otpAttempts.set(mdOrder, tries);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(otpPage(order, (p.pan ?? '').trim(), langOf(p.language ?? null), 3 - tries));
      return;
    }
    otpAttempts.delete(mdOrder);
    if (p.pan && p.pan.trim()) {
      core.pay(mdOrder, { card: p.pan.trim() }); // the card's outcome decides paid vs declined
    } else {
      core.pay(mdOrder);
    }
    redirectFor(res, mdOrder);
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
        res.end(page(reqUrl.searchParams.get('mdOrder'), reqUrl.searchParams.get('language')));
        return;
      }
      if (method === 'POST' && path === '/pay') {
        handlePay(res, await readForm(req));
        return;
      }
      if (method === 'POST' && path === '/pay/otp') {
        handleOtp(res, await readForm(req));
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
