import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { CloudBasePgStorage } from './cloudbase-pg-storage.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp({
  config,
  storage: new CloudBasePgStorage(config),
  publicOrigin: config.publicOrigin,
});

serve({
  fetch: app.fetch,
  port: config.port,
}, (info) => {
  console.log(`CloudBase public file proxy listening on http://localhost:${info.port}`);
});
