import { config } from './config.js';
import { createApp } from './app.js';
import { openStore } from './store.js';

const store = await openStore(config);
const { server } = await createApp(config, { store });

server.listen(config.port, () => {
  console.log(`Mock API Studio listening on http://localhost:${config.port}`);
  console.log(`  UI                    http://localhost:${config.port}/`);
  console.log('  POST /oauth/token     client_credentials (create OAuth clients in the UI)');
  console.log('  /api/v1/<resource>    GET list · POST create · GET/PUT/PATCH/DELETE /<id>');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(async () => {
    await store.close();
    process.exit(0);
  }));
}
