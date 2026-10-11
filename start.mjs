import { preparePlugin } from './setup.mjs';

preparePlugin();
const { startServer } = await import('./server.ts');
await startServer();
