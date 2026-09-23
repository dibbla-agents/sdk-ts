// Serves /health for the platform's probes, then runs the conformance worker.
import * as http from 'node:http';

http
  .createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(req.url === '/health' ? 'ok' : 'not found');
  })
  .listen(Number(process.env.PORT ?? 80));

require('./worker.ts');
