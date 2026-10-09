// Entry point: opens the database, then serves the API (and the built web app, if present) on 127.0.0.1 only.
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { openDb, resolveDataDir } from './db';

const port = Number(process.env.PORT ?? 8787);
const dataDir = resolveDataDir();

async function main() {
  const db = await openDb(dataDir);
  const app = createApp(db, { dataDir, port, staticDir: fileURLToPath(new URL('../../dist', import.meta.url)) });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
    console.log(`Encounter running at http://127.0.0.1:${port} (data: ${dataDir})`);
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to another value or stop the other process.` : `Server error: ${e.message}`);
    process.exit(1);
  });
  const shutdown = () => {
    server.close();
    db.$client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(`Encounter could not start: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
