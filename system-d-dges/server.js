const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3003);
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
  'DIP-LIC-2025-001': { numero_diplome: 'DIP-LIC-2025-001', npi_titulaire: '10000000000001', intitule_grade: 'Licence', filiere: 'Sécurité Informatique', annee_obtention: 2025 },
  'DIP-LIC-2024-042': { numero_diplome: 'DIP-LIC-2024-042', npi_titulaire: '10000000000002', intitule_grade: 'Licence', filiere: 'Gestion des Entreprises', annee_obtention: 2024 }
};

let diplomes = {};
if (fs.existsSync(DB_FILE)) { diplomes = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
else { fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2)); diplomes = { ...DEFAULT_DATA }; }

function save() { fs.writeFileSync(DB_FILE, JSON.stringify(diplomes, null, 2)); }

function sendLog(direction, method, p, status, detail) {
  if (LOG_DISABLED) return;
  const data = JSON.stringify({ source: 'D-DGES', direction, method, path: p, status, detail, time: new Date().toISOString() });
  try {
    const req = https.request({ hostname: LOG_HOST, port: LOG_PORT, path: '/api/logs/push', method: 'POST', ca: caCert, rejectUnauthorized: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { res.resume(); });
    req.on('error', (e) => { console.error(`[DGES] sendLog ERROR: ${e.message}`); }); req.write(data); req.end();
  } catch(e) { console.error(`[DGES] sendLog EXCEPTION: ${e.message}`); }
}

// Certificate auth — only for inter-system endpoint
function certAuth(req, res, next) {
  if (TRUST_XROAD && req.header('X-Road-Client')) {
    const allowedXroadClients = ['BJ/GOV/PORTAL/CONCOURS', 'BJ/GOV/ANIP/REGISTRY'];
    const client = req.header('X-Road-Client');
    if (!allowedXroadClients.includes(client)) {
      sendLog('REJECT', req.method, req.path, 403, `X-Road client "${client}" non autorisé`);
      return res.status(403).json({ error: `X-Road client non autorisé: ${client}`, code: 'XROAD_UNAUTHORIZED' });
    }
    req.clientCN = client;
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
app.get('/api/v1/diplomes', (req, res) => { res.json(Object.values(diplomes)); });
app.get('/api/v1/diplomes/:numero', (req, res) => { const d=diplomes[req.params.numero]; if(!d) return res.status(404).json({error:'Non trouvé'}); res.json(d); });
app.post('/api/v1/diplomes', (req, res) => { const {numero_diplome,npi_titulaire,intitule_grade,filiere,annee_obtention}=req.body; if(!numero_diplome||!npi_titulaire||!intitule_grade||!filiere||!annee_obtention) return res.status(400).json({error:'Champs requis manquants'}); if(diplomes[numero_diplome]) return res.status(409).json({error:'Diplôme déjà existant'}); diplomes[numero_diplome]={numero_diplome,npi_titulaire,intitule_grade,filiere,annee_obtention}; save(); res.status(201).json(diplomes[numero_diplome]); });
app.put('/api/v1/diplomes/:numero', (req, res) => { const d=diplomes[req.params.numero]; if(!d) return res.status(404).json({error:'Non trouvé'}); Object.assign(d,req.body); save(); res.json(d); });
app.delete('/api/v1/diplomes/:numero', (req, res) => { if(!diplomes[req.params.numero]) return res.status(404).json({error:'Non trouvé'}); delete diplomes[req.params.numero]; save(); res.json({ok:true}); });

// Inter-system endpoint — requires client cert
app.post('/api/v1/dges/diplome/verifier', certAuth, (req, res) => {
  const { npi, numero_diplome } = req.body;
  sendLog('IN', 'POST', '/api/v1/dges/diplome/verifier', '-', `Requete de "${req.clientCN}" — NPI=${npi} Diplôme=${numero_diplome}`);
  if (!npi || !numero_diplome) { sendLog('REJECT', 'POST', '/api/v1/dges/diplome/verifier', 400, 'Champs requis manquants'); return res.status(400).json({ error: 'Champs requis' }); }
  const d = diplomes[numero_diplome];
  if (!d || d.npi_titulaire !== npi) { sendLog('REJECT', 'POST', '/api/v1/dges/diplome/verifier', 404, 'Diplôme non trouvé'); return res.status(404).json({ error: 'Diplôme non trouvé' }); }
  sendLog('SUCCESS', 'POST', '/api/v1/dges/diplome/verifier', 200, `Diplôme ${numero_diplome} authentique — ${d.filiere}`);
  res.json({ authentique: true, filiere: d.filiere, intitule_grade: d.intitule_grade, annee_obtention: d.annee_obtention });
});

app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/', (req, res) => { res.redirect('/admin'); });

if (HTTP_ONLY) {
  http.createServer(app).listen(PORT, () => {
    console.log(`[DGES] HTTP Port ${PORT} — backend interne X-Road`);
  });
} else {
  const httpsServer = https.createServer({
    cert: serverCert, key: serverKey, ca: caCert,
    requestCert: true, rejectUnauthorized: false
  }, app);

  httpsServer.listen(PORT, () => {
    console.log(`[DGES] HTTPS Port ${PORT} — Admin: https://localhost:${PORT}`);
    console.log(`[DGES] Certificat serveur: CN=DGES-Diplomes`);
    console.log(`[DGES] Certificats clients acceptés: Portal-Concours, ANIP-Registry`);
  });
}
