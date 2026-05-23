#!/usr/bin/env node
import { createMockSatimServer, type MockSatimServerOptions } from './server.js';
import type { Outcome } from './core.js';

/** Tiny `--flag value` / `--flag=value` parser (no dependency). */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const key = a.slice(2);
    const eq = key.indexOf('=');
    if (eq !== -1) {
      out[key.slice(0, eq)] = key.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      out[key] = next && !next.startsWith('--') ? (i++, next) : 'true';
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    process.stdout.write(
      [
        'satim-mock — a standalone SATIM gateway simulator for CI / e2e UI testing',
        '',
        'Usage: satim-mock [--port 8888] [--host 127.0.0.1] [--public-url URL] [--scenario approved|declined|abandoned]',
        '',
        '  --port        port to listen on (default 8888; 0 = ephemeral)',
        '  --host        host to bind (default 127.0.0.1)',
        '  --public-url  browser-facing base URL for the payment page (default = bound origin)',
        '  --scenario    default outcome for orders settled without a card (default approved)',
        '',
        'Point your app at  <url>/payment/rest  and drive the page at <url>/pay with a browser.',
        '',
      ].join('\n'),
    );
    return;
  }

  const opts: MockSatimServerOptions = {};
  if (args.host) opts.host = args.host;
  if (args['public-url']) opts.publicUrl = args['public-url'];
  if (args.scenario) opts.scenario = args.scenario as Outcome;

  const mock = createMockSatimServer(opts);
  const port = args.port ? Number(args.port) : 8888;
  const origin = await mock.listen(port);

  process.stdout.write(
    [
      `mock SATIM listening on ${origin}`,
      `  apiBaseUrl : ${mock.apiBaseUrl()}     (point your app's SATIM client here)`,
      `  payment page: ${opts.publicUrl ?? origin}/pay?mdOrder=<id>`,
      '',
    ].join('\n'),
  );

  const shutdown = (): void => {
    void mock.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
