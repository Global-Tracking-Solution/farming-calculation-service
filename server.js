// Entry point:  node server.js
// Settings come from environment variables; a .env file next to this file is loaded if present.
import fs from 'fs';
import {loadConfig, VERSION} from './src/config/index.js';
import {createApp} from './src/app.js';

const envFile = new URL('./.env', import.meta.url);
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile); // never overrides variables already set (e.g. by the Windows service)
}

const config = loadConfig();

if (config.isProd && !config.apiKeys.length && !config.allowNoAuth) {
  console.error('Refusing to start: NODE_ENV=production but API_KEYS is empty. Set API_KEYS=key1,key2 (or ALLOW_NO_AUTH=true if the API is protected some other way).');
  process.exit(1);
}

const app = createApp(config);
const server = app.listen(config.port, () => {
  console.log(`Farming API v${VERSION} listening on :${config.port} (TZ=${process.env.TZ || 'system'}, auth=${config.apiKeys.length ? 'api-key' : 'OFF'}, workers<=${config.maxConcurrent})`);
});

// behind IIS / a reverse proxy: keep connections a bit longer than the proxy's idle timeout
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = config.jobTimeoutMs + 15000;

const shutdown = signal => {
  console.log(`${signal} received, finishing requests...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 15000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
