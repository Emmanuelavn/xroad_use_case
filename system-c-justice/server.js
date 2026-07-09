const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3002);
const DB_FILE = path.join(__dirname, 'data.json');
const CERTS_DIR = path.join(__dirname, 'certs');
const LOG_HOST = process.env.LOG_HOST || 'localhost';
const LOG_PORT = Number(process.env.LOG_PORT || 3000);
const LOG_DISABLED = process.env.LOG_DISABLED === 'true';
const TRUST_XROAD = process.env.TRUST_XROAD === 'true';
const HTTP_ONLY = process.env.HTTP_ONLY === 'true';

const serverCert = fs.readFileSync(path.join(CERTS_DIR, 'server-cert.pem'));
const serverKey = fs.readFileSync(path.join(CERTS_DIR, 'server-key.pem'));
const caCert = fs.readFileSync(path.join(CERTS_DIR, 'ca-cert.pem'));

const DEFAULT_DATA = {
  '10000000000001': { npi: '10000000000001', statut_casier: 'VIERGE', motif_condamnation: null, reference_bulletin: 'CJ-2026-A01' },
  '10000000000002': { npi: '10000000000002', statut_casier: 'NON_VIERGE', motif_condamnation: 'Fraude fiscale', reference_bulletin: 'CJ-2026-B02' },
  '10000000000003': { npi: '10000000000003', statut_casier: 'VIERGE', motif_condamnation: null, reference_bulletin: 'CJ-2026-C03' }
};

let casiers = {};
if (fs.existsSync(DB_FILE)) { casiers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
else { fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2)); casiers = { ...DEFAULT_DATA }; }

function save() { fs.writeFileSync(DB_FILE, JSON.stringify(casiers, null, 2)); }

function sendLog(direction, method, p, status, detail) {
  if (LOG_DISABLED) return;
  const data = JSON.stringify({ source: 'C-JUSTICE', direction, method, path: p, status, detail, time: new Date().toISOString() });
  try {
    const req = https.request({ hostname: LOG_HOST, port: LOG_PORT, path: '/api/logs/push', method: 'POST', ca: caCert, rejectUnauthorized: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { res.resume(); });
    req.on('error', (e) => { console.error(`[Justice] sendLog ERROR: ${e.message}`); }); req.write(data); req.end();
  } catch(e) { console.error(`[Justice] sendLog EXCEPTION: ${e.message}`); }
}

// Certificate auth — only for inter-system endpoint
function certAuth(req, res, next) {
  const trustedClient = req.header('Uxp-Client') || req.header('X-Road-Client');
  if (TRUST_XROAD && trustedClient) {
    req.clientCN = trustedClient;
    return next();
  }
  const cert = req.socket.getPeerCertificate();
  if (!cert || !cert.subject) {
    sendLog('REJECT', req.method, req.path, 401, 'Aucun certificat client');
    return res.status(401).json({ error: 'Certificat client requis', code: 'CERT_REQUIRED' });
  }
  const allowedCNs = ['Portal-Concours', 'ANIP-Registry'];
  const cn = cert.subject.CN;
  if (!allowedCNs.includes(cn)) {
    sendLog('REJECT', req.method, req.path, 403, `CN "${cn}" non autorisé`);
    return res.status(403).json({ error: `Certificat non autorisé: ${cn}`, code: 'CERT_UNAUTHORIZED' });
  }
  req.clientCN = cn;
  next();
}

// CRUD — open to admin
app.get('/api/v1/casiers', (req, res) => { res.json(Object.values(casiers)); });
app.get('/api/v1/casiers/:npi', (req, res) => { const c=casiers[req.params.npi]; if(!c) return res.status(404).json({error:'Non trouvé'}); res.json(c); });
app.post('/api/v1/casiers', (req, res) => { const {npi,statut_casier,motif_condamnation,reference_bulletin}=req.body; if(!npi||!statut_casier||!reference_bulletin) return res.status(400).json({error:'Champs requis manquants'}); if(casiers[npi]) return res.status(409).json({error:'NPI déjà existant'}); casiers[npi]={npi,statut_casier,motif_condamnation:motif_condamnation||null,reference_bulletin}; save(); res.status(201).json(casiers[npi]); });
app.put('/api/v1/casiers/:npi', (req, res) => { const c=casiers[req.params.npi]; if(!c) return res.status(404).json({error:'Non trouvé'}); Object.assign(c,req.body); save(); res.json(c); });
app.delete('/api/v1/casiers/:npi', (req, res) => { if(!casiers[req.params.npi]) return res.status(404).json({error:'Non trouvé'}); delete casiers[req.params.npi]; save(); res.json({ok:true}); });

// Inter-system endpoint — requires client cert
app.get('/api/v1/justice/casier/:npi', certAuth, (req, res) => {
  sendLog('IN', 'GET', `/api/v1/justice/casier/${req.params.npi}`, '-', `Requete de "${req.clientCN}" — NPI ${req.params.npi}`);
  const c = casiers[req.params.npi];
  if (!c) { sendLog('REJECT', 'GET', `/api/v1/justice/casier/${req.params.npi}`, 404, 'NPI non trouvé'); return res.status(404).json({ error: 'NPI non trouvé' }); }
  sendLog('SUCCESS', 'GET', `/api/v1/justice/casier/${req.params.npi}`, 200, `Casier ${c.statut_casier}`);
  const { npi, ...evidence } = c;
  res.json(evidence);
});

app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/', (req, res) => { res.redirect('/admin'); });

if (HTTP_ONLY) {
  http.createServer(app).listen(PORT, () => {
    console.log(`[Justice] HTTP Port ${PORT} — backend interne X-Road`);
  });
} else {
  const httpsServer = https.createServer({
    cert: serverCert, key: serverKey, ca: caCert,
    requestCert: true, rejectUnauthorized: false
  }, app);

  httpsServer.listen(PORT, () => {
    console.log(`[Justice] HTTPS Port ${PORT} — Admin: https://localhost:${PORT}`);
    console.log(`[Justice] Certificat serveur: CN=Justice-Casier`);
    console.log(`[Justice] Certificats clients acceptés: Portal-Concours, ANIP-Registry`);
  });
}
