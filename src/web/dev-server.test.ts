import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import config from '../../vite.config';

it('serves the frontend API module as JavaScript while proxying API endpoints', async () => {
  const requests: string[] = [];
  const backend = createHttpServer((req, res) => {
    requests.push(req.url!);
    const health = req.url === '/api/v1/health';
    res.setHeader('Content-Type', health ? 'application/json' : 'text/html');
    res.end(health ? JSON.stringify({ status: 'ok' }) : '<html>Encounter</html>');
  });
  const cacheDir = await mkdtemp(join(tmpdir(), 'encounter-vite-test-'));
  let vite: ViteDevServer | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      backend.once('error', reject);
      backend.listen(0, '127.0.0.1', resolve);
    });
    const target = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    vite = await createServer({
      ...config, configFile: false, cacheDir,
      server: {
        ...config.server, port: 0, hmr: false,
        // Keep the real proxy matchers; use an isolated backend instead of the user's API.
        proxy: Object.fromEntries(Object.keys(config.server!.proxy!).map((key) => [key, target])),
      },
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;

    const module = await fetch(`${origin}/api.ts`);
    expect(module.status).toBe(200);
    expect(module.headers.get('content-type')).toContain('javascript');
    expect(await module.text()).toContain('export');
    expect(requests).toEqual([]);

    const health = await fetch(`${origin}/api/v1/health`);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect(requests).toEqual(['/api/v1/health']);
  } finally {
    await vite?.close();
    if (backend.listening) {
      await new Promise<void>((resolve, reject) => backend.close((error) => error ? reject(error) : resolve()));
    }
    await rm(cacheDir, { recursive: true, force: true });
  }
});
