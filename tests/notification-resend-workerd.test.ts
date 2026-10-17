import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * Real-workerd verification of the pinned Resend SDK boundary: the probe
 * worker imports the adapter, and Miniflare's outbound service mocks the
 * provider. `NODE_ENV=production` mirrors the deployed configuration so the
 * SDK's raw-error logger is inert; the test also asserts nothing raw reached
 * the host console.
 */

const repoRoot = process.cwd();

let workerScript: null | Promise<string> = null;
const bundleProbe = async (): Promise<string> => {
  workerScript ??= (async () => {
    const bundled = await build({
      alias: { '@': join(repoRoot, 'src') },
      bundle: true,
      conditions: ['workerd'],
      define: { 'process.env.NODE_ENV': '"production"' },
      external: ['cloudflare:*', 'node:*'],
      format: 'esm',
      platform: 'browser',
      stdin: {
        contents: `
import { Effect } from 'effect';
import { createResendEmailProvider } from '@/notifications/providers/resend';

const envelope = {
  from: { email: 'notifications@example.test', name: 'LeadScroll' },
  html: '<p>Hi</p>',
  subject: 'Probe',
  text: 'Hi',
  to: 'staff@example.test',
};

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const provider = createResendEmailProvider('re_probe_key');
    const result = await Effect.runPromise(
      provider.send({
        deliveryKey: 'leadscroll-notification:probe',
        envelope,
        timeoutMs: path === '/hang' ? 50 : 1000,
      }),
    );
    return Response.json(result);
  },
};
        `,
        loader: 'ts',
        resolveDir: repoRoot,
        sourcefile: 'resend-probe.ts',
      },
      target: 'es2022',
      tsconfig: join(repoRoot, 'tsconfig.json'),
      write: false,
    });
    return bundled.outputFiles[0].text;
  })();
  return workerScript;
};

type OutboundCall = { headers: Record<string, string>; url: string };

type ProbeFixture = {
  calls: OutboundCall[];
  dispose: () => Promise<void>;
  send: (path: string) => Promise<Record<string, unknown>>;
  setBehavior: (
    behavior: { kind: 'hang' } | { kind: 'response'; response: Response },
  ) => void;
};

const fixtures: ProbeFixture[] = [];

const startProbe = async (): Promise<ProbeFixture> => {
  const script = await bundleProbe();
  const calls: OutboundCall[] = [];
  let behavior: { kind: 'hang' } | { kind: 'response'; response: Response } = {
    kind: 'response',
    response: Response.json({ id: 're_probe_default' }),
  };

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        // The supported seam that keeps the pinned SDK's raw logger inert.
        NODE_ENV: 'production',
      },
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      modules: true,
      outboundService: (async (request: Request) => {
        calls.push({
          headers: Object.fromEntries(request.headers.entries()),
          url: request.url,
        });
        if (behavior.kind === 'hang') {
          return await new Promise<Response>(() => {});
        }

        return behavior.response.clone();
      }) as never,
      script,
    }),
  );

  let disposed = false;
  const fixture: ProbeFixture = {
    calls,
    dispose: async () => {
      if (disposed) {
        return;
      }

      disposed = true;
      await mf.dispose();
    },
    send: async (path) => {
      const response = await mf.dispatchFetch(`https://probe.test${path}`);
      return (await response.json()) as Record<string, unknown>;
    },
    setBehavior: (next) => {
      behavior = next;
    },
  };
  fixtures.push(fixture);
  return fixture;
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fx) => fx.dispose()));
  vi.restoreAllMocks();
});

describe('Resend SDK boundary under workerd', () => {
  test('sends through the fixed host with the namespaced idempotency key', async () => {
    const fx = await startProbe();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fx.send('/send');

    expect(result).toEqual({
      kind: 'accepted',
      messageId: 're_probe_default',
      provider: 'resend',
    });
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0].url).toBe('https://api.resend.com/emails');
    expect(fx.calls[0].headers['idempotency-key']).toBe(
      'leadscroll-notification:probe',
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('timed-out requests abort, report unknown, and are never retried', async () => {
    const fx = await startProbe();
    fx.setBehavior({ kind: 'hang' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fx.send('/hang');

    expect(result).toEqual({
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'timeout',
    });
    expect(fx.calls).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('raw provider error text never leaks through the SDK logger', async () => {
    const fx = await startProbe();
    fx.setBehavior({
      kind: 'response',
      response: Response.json(
        {
          message: 'SENTINEL body',
          name: 'SENTINEL name',
          statusCode: 422,
        },
        { status: 422 },
      ),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await fx.send('/send');

    expect(result).toEqual({
      kind: 'rejected',
      provider: 'resend',
      reason: 'http_422',
      retryable: false,
    });
    expect(fx.calls).toHaveLength(1);
    const emitted = JSON.stringify([
      ...errorSpy.mock.calls,
      ...logSpy.mock.calls,
    ]);
    expect(emitted).not.toContain('SENTINEL');
  });
});
