// Standalone fake server for manual testing: npm run fake-server -- --port 8787 [--no-ai]
//   [--access-id ID --access-secret SECRET [--access-mode redirect|forbidden|html]]
import { parseArgs } from 'node:util';
import { ALICE, startFakeServer } from './server.mjs';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    'no-ai': { type: 'boolean', default: false },
    'access-id': { type: 'string' },
    'access-secret': { type: 'string' },
    'access-mode': { type: 'string', default: 'redirect' },
  },
});

const access = values['access-id']
  ? { clientId: values['access-id'], clientSecret: values['access-secret'] ?? '', mode: values['access-mode'] }
  : null;
const server = await startFakeServer({ port: Number(values.port), host: values.host, ai: !values['no-ai'], access });
console.log(`fake shelfmark at ${server.url}  (login ${ALICE.username} / ${ALICE.password})`);
process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
