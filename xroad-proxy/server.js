const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const express = require('express');

const app = express();
app.use(express.raw({ type: '*/*', limit: process.env.MAX_BODY_SIZE || '10mb' }));

const PORT = Number(process.env.PORT || 8080);
const LOCAL_MEMBER = process.env.LOCAL_MEMBER;
const CONFIG_FILE = process.env.XROAD_CONFIG || path.join(__dirname, 'config.json');

if (!LOCAL_MEMBER) {
  console.error('LOCAL_MEMBER is required, for example BJ/GOV/ANIP/REGISTRY');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const services = new Map(config.services.map((service) => [service.id, service]));
const members = new Map(config.members.map((member) => [member.id, member]));
const acl = config.acl || {};

function json(res, status, payload, headers = {}) {
  res.status(status).set(headers).json(payload);
}

function splitXroadPath(originalUrl) {
  const [pathOnly, query = ''] = originalUrl.split('?');
  const parts = pathOnly.split('/').filter(Boolean);
  if (parts[0] !== 'r1' || parts.length < 6) return null;

  const serviceId = parts.slice(1, 6).join('/');
  const restPath = '/' + parts.slice(6).join('/');
  return {
    protocol: parts[0],
    serviceId,
    providerMember: parts.slice(1, 5).join('/'),
    restPath,
    query: query ? `?${query}` : ''
  };
}

function isAllowed(clientId, serviceId) {
  const allowedServices = acl[clientId] || [];
  return allowedServices.includes(serviceId);
}

function requestHash(req, body) {
  const headers = Object.entries(req.headers)
    .filter(([key]) => key.toLowerCase() !== 'x-road-request-hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}`)
    .join('\n');

  const headersHash = crypto.createHash('sha512').update(headers).digest();
  const bodyHash = crypto.createHash('sha512').update(body || Buffer.alloc(0)).digest();
  return crypto.createHash('sha512').update(Buffer.concat([headersHash, bodyHash])).digest('base64');
}

function forward(method, targetUrl, req, body, xroad) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const transport = target.protocol === 'https:' ? https : http;
    const headers = { ...req.headers };

    delete headers.host;
    headers['x-road-client'] = xroad.clientId;
    headers['x-road-service'] = xroad.serviceId;
    headers['x-road-id'] = xroad.messageId;
    headers['x-road-request-id'] = xroad.requestId;
    headers['x-road-security-server'] = LOCAL_MEMBER;

    if (body?.length) headers['content-length'] = body.length;
    else delete headers['content-length'];

    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers,
      rejectUnauthorized: false
    };

    const outbound = transport.request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks)
        });
      });
    });

    outbound.on('error', reject);
    if (body?.length) outbound.write(body);
    outbound.end();
  });
}

app.get('/health', (req, res) => {
  res.json({ ok: true, member: LOCAL_MEMBER });
});

app.all('/r1/*', async (req, res) => {
  const parsed = splitXroadPath(req.originalUrl);
  if (!parsed) return json(res, 400, { error: 'Invalid X-Road REST path. Expected /r1/{instance}/{class}/{member}/{subsystem}/{serviceCode}/...' });

  const clientId = req.header('X-Road-Client');
  const messageId = req.header('X-Road-Id') || crypto.randomUUID();
  const requestId = req.header('X-Road-Request-Id') || crypto.randomUUID();
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  if (!clientId) return json(res, 400, { error: 'X-Road-Client header is required' });
  if (!isAllowed(clientId, parsed.serviceId)) {
    return json(res, 403, {
      error: 'X-Road ACL denied',
      client: clientId,
      service: parsed.serviceId
    }, { 'X-Road-Error': 'acl-denied' });
  }

  const xroad = { clientId, serviceId: parsed.serviceId, messageId, requestId };
  const responseHeaders = {
    'X-Road-Id': messageId,
    'X-Road-Client': clientId,
    'X-Road-Service': parsed.serviceId,
    'X-Road-Request-Id': requestId,
    'X-Road-Request-Hash': requestHash(req, body)
  };

  try {
    let targetUrl;
    if (parsed.providerMember === LOCAL_MEMBER) {
      const service = services.get(parsed.serviceId);
      if (!service) return json(res, 404, { error: 'Unknown local X-Road service', service: parsed.serviceId });
      targetUrl = `${service.backendUrl}${parsed.restPath}${parsed.query}`;
    } else {
      const provider = members.get(parsed.providerMember);
      if (!provider) return json(res, 404, { error: 'Unknown X-Road provider member', provider: parsed.providerMember });
      targetUrl = `${provider.securityServerUrl}${req.originalUrl}`;
    }

    console.log(`[${LOCAL_MEMBER}] ${clientId} -> ${parsed.serviceId} ${req.method} ${parsed.restPath}`);
    const upstream = await forward(req.method, targetUrl, req, body, xroad);
    Object.entries(upstream.headers || {}).forEach(([key, value]) => {
      const lower = key.toLowerCase();
      if (!['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(lower)) {
        res.set(key, value);
      }
    });
    res.set(responseHeaders);
    res.status(upstream.status || 502).send(upstream.body);
  } catch (error) {
    console.error(`[${LOCAL_MEMBER}] proxy error: ${error.message}`);
    json(res, 502, { error: 'X-Road proxy error', detail: error.message }, { ...responseHeaders, 'X-Road-Error': 'proxy-error' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'X-Road proxy endpoint not found' });
});

app.listen(PORT, () => {
  console.log(`[XROAD] ${LOCAL_MEMBER} Security Server simulation listening on ${PORT}`);
});
