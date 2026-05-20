const express = require('express');
const os = require('os');
const client = require('prom-client');

const app = express();
const PORT = process.env.PORT || 3000;
const PET = process.env.PET || 'dog';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests received',
  registers: [register],
});

let requestCount = 0;

app.get('/', (req, res) => {
  requestCount++;
  httpRequestsTotal.inc();
  res.json({
    hostname: os.hostname(),
    pet: PET,
    requestCount,
  });
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
