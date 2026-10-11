import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { configuredRoot, httpHandler } from './server.ts';

const handler = httpHandler(configuredRoot());
const port = Number(process.argv[3] ?? 8732);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid preview port.');
const host = localhostHostValidation(), origin = localhostOriginValidation();
createServer(async (req, res) => {
  if (!host(req, res) || !origin(req, res)) return;
  if (req.url === '/mcp') { await handler(req, res); return; }
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(new URL('./dist/preview.html', import.meta.url)));
    return;
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${port}`));
