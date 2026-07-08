const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3001);
const DB_FILE = path.join(__dirname, 'data.json');
const CERTS_DIR = path.join(__dirname, 'certs');
const LOG_HOST = process.env.LOG_HOST || 'localhost';
const LOG_PORT = Number(process.env.LOG_PORT || 3000);
const TRUST_XROAD = process.env.TRUST_XROAD === 'true';
const XROAD_BASE_URL = process.env.XROAD_BASE_URL;
const XROAD_CLIENT = process.env.XROAD_CLIENT || 'BJ/GOV/ANIP/REGISTRY';

const serverCert = fs.readFileSync(path.join(CERTS_DIR, 'server-cert.pem'));
const serverKey = fs.readFileSync(path.join(CERTS_DIR, 'server-key.pem'));
const caCert = fs.readFileSync(path.join(CERTS_DIR, 'ca-cert.pem'));
const clientCert = fs.readFileSync(path.join(CERTS_DIR, 'client-cert.pem'));
const clientKey = fs.readFileSync(path.join(CERTS_DIR, 'client-key.pem'));

const DEFAULT_DATA = {
  '10000000000001': { npi: '10000000000001', nom: 'HOUNGBE', prenoms: 'Idriss', date_naissance: '2004-05-12', nationalite: 'Béninoise' },
  '10000000000002': { npi: '10000000000002', nom: 'TOSSA', prenoms: 'Chantal', date_naissance: '2001-11-20', nationalite: 'Béninoise' },
  '10000000000003': { npi: '10000000000003', nom: 'KOFFI', prenoms: 'Kouassi', date_naissance: '1999-08-15', nationalite: 'Ivoirienne' }
};

let personnes = {};
if (fs.existsSync(DB_FILE)) { personnes = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
else { fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2)); personnes = { ...DEFAULT_DATA }; }

function save() { fs.writeFileSync(DB_FILE, JSON.stringify(personnes, null, 2)); }

function sendLog(direction, method, p, status, detail) {
  const data = JSON.stringify({ source: 'B-ANIP', direction, method, path: p, status, detail, time: new Date().toISOString() });
  try {
    const req = https.request({ hostname: LOG_HOST, port: LOG_PORT, path: '/api/logs/push', method: 'POST', ca: caCert, rejectUnauthorized: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { res.resume(); });
    req.on('error', (e) => { console.error(`[ANIP] sendLog ERROR: ${e.message}`); }); req.write(data); req.end();
  } catch(e) { console.error(`[ANIP] sendLog EXCEPTION: ${e.message}`); }
}

function certAuth(req, res, next) {
  if (TRUST_XROAD && req.header('X-Road-Client')) {
    const allowedXroadClients = ['BJ/GOV/PORTAL/CONCOURS'];
    const client = req.header('X-Road-Client');
    if (!allowedXroadClients.includes(client)) {
      sendLog('REJECT', req.method, req.path, 403, `X-Road client "${client}" non autorisé`);
      return res.status(403).json({ error: `X-Road client non autorisé: ${client}`, code: 'XROAD_UNAUTHORIZED' });
    }
    req.clientCN = client;
    return next();
  }
  if (req.path.startsWith('/admin') || req.path === '/' || req.path === '/favicon.ico') return next();
  const cert = req.socket.getPeerCertificate();
  if (!cert || !cert.subject) {
    sendLog('REJECT', req.method, req.path, 401, 'Aucun certificat client');
    return res.status(401).json({ error: 'Certificat client requis', code: 'CERT_REQUIRED' });
  }
  const allowedCNs = ['Portal-Concours'];
  const cn = cert.subject.CN;
  if (!allowedCNs.includes(cn)) {
    sendLog('REJECT', req.method, req.path, 403, `CN "${cn}" non autorisé`);
    return res.status(403).json({ error: `Certificat non autorisé: ${cn}`, code: 'CERT_UNAUTHORIZED' });
  }
  req.clientCN = cn;
  next();
}

function callServiceXRoad(method, serviceId, restPath, body) {
  const target = `${XROAD_BASE_URL}/r1/${serviceId}${restPath}`;
  return callServiceHTTP(method, target, body, { 'X-Road-Client': XROAD_CLIENT });
}

function callServiceHTTP(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const transport = urlObj.protocol === 'https:' ? https : http;
    const postData = body ? JSON.stringify(body) : null;
    sendLog('OUT', method, urlObj.pathname, '-', `Via X-Road ${XROAD_CLIENT}`);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: `${urlObj.pathname}${urlObj.search}`,
      method,
      rejectUnauthorized: false,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers,
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    };
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        sendLog('IN', method, urlObj.pathname, res.statusCode, `${res.statusCode === 200 ? 'OK' : 'FAIL'} — X-Road`);
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', (e) => { sendLog('ERROR', method, urlObj.pathname, '-', e.message); reject(e); });
    if (postData) req.write(postData);
    req.end();
  });
}

// HTTPS call with client certificate
function callServiceHTTPS(method, url, body) {
  if (XROAD_BASE_URL) {
    const urlObj = new URL(url);
    if (urlObj.port === '3002') return callServiceXRoad(method, 'BJ/GOV/JUSTICE/CASIER/justice', urlObj.pathname, body);
    if (urlObj.port === '3003') return callServiceXRoad(method, 'BJ/GOV/DGES/DIPLOMES/dges', urlObj.pathname, body);
  }
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = body ? JSON.stringify(body) : null;
    sendLog('OUT', method, urlObj.pathname, '-', `Vers ${urlObj.hostname}:${urlObj.port} (certificat client ANIP-Registry)`);
    const options = {
      hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, method,
      cert: clientCert, key: clientKey, ca: caCert, rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let serverCN = 'inconnu';
        try { const ci = res.socket?.getPeerCertificate(); if (ci?.subject) serverCN = ci.subject.CN; } catch(e) {}
        sendLog('IN', method, urlObj.pathname, res.statusCode, `${res.statusCode === 200 ? 'OK' : 'FAIL'} — Serveur: ${serverCN}`);
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', (e) => { sendLog('ERROR', method, urlObj.pathname, '-', e.message); reject(e); });
    if (postData) req.write(postData);
    req.end();
  });
}

app.post('/api/v1/concours/verifier', certAuth, async (req, res) => {
  const { npi, numero_diplome } = req.body;
  sendLog('IN', 'POST', '/api/v1/concours/verifier', '-', `Requete de "${req.clientCN}" — NPI=${npi}`);

  if (!npi || !numero_diplome) return res.status(400).json({ succes: false, motif: 'NPI et numéro de diplôme requis' });

  const personne = personnes[npi];
  if (!personne) { sendLog('REJECT', 'POST', '/api/v1/concours/verifier', 404, `NPI ${npi} inconnu`); return res.status(404).json({ succes: false, motif: 'NPI inconnu au registre national de l\'ANIP' }); }

  if (personne.nationalite !== 'Béninoise') { sendLog('REJECT', 'POST', '/api/v1/concours/verifier', 403, `Nationalité ${personne.nationalite}`); return res.status(403).json({ succes: false, motif: `Candidature refusée : Nationalité non conforme (${personne.nationalite}). Seuls les citoyens béninois sont éligibles.` }); }

  // Call Justice via HTTPS with client certificate
  let casier;
  try { casier = await callServiceHTTPS('GET', `https://localhost:3002/api/v1/justice/casier/${npi}`); }
  catch (e) { sendLog('ERROR', 'GET', '/api/v1/justice/casier/:npi', 503, 'Justice indisponible'); return res.status(503).json({ succes: false, motif: 'Service Justice indisponible. Réessayez plus tard.' }); }
  if (casier.status !== 200) { sendLog('REJECT', 'GET', '/api/v1/justice/casier/:npi', casier.status, 'Casier non trouvé'); return res.status(404).json({ succes: false, motif: 'NPI non trouvé dans le registre du casier judiciaire' }); }
  if (casier.body.statut_casier !== 'VIERGE') { sendLog('REJECT', 'GET', '/api/v1/justice/casier/:npi', 403, `Casier ${casier.body.statut_casier}`); return res.status(403).json({ succes: false, motif: `Candidature refusée : Casier judiciaire non vierge — ${casier.body.motif_condamnation || 'Antécédent(s) judiciaire(s)'}` }); }

  // Call DGES via HTTPS with client certificate
  let diplome;
  try { diplome = await callServiceHTTPS('POST', 'https://localhost:3003/api/v1/dges/diplome/verifier', { npi, numero_diplome }); }
  catch (e) { sendLog('ERROR', 'POST', '/api/v1/dges/diplome/verifier', 503, 'DGES indisponible'); return res.status(503).json({ succes: false, motif: 'Service DGES indisponible. Réessayez plus tard.' }); }
  if (diplome.status !== 200) { sendLog('REJECT', 'POST', '/api/v1/dges/diplome/verifier', 403, 'Diplôme non validé'); return res.status(403).json({ succes: false, motif: 'Candidature refusée : Diplôme non reconnu ou ne correspondant pas au NPI déclaré' }); }

  sendLog('SUCCESS', 'POST', '/api/v1/concours/verifier', 200, `${personne.prenoms} ${personne.nom} validé`);
  res.json({
    succes: true,
    candidat: { nom: personne.nom, prenoms: personne.prenoms, nationalite: personne.nationalite },
    casier: { statut: casier.body.statut_casier },
    diplome: { authentique: diplome.body.authentique, filiere: diplome.body.filiere, grade: diplome.body.intitule_grade }
  });
});

// CRUD API
app.get('/api/v1/personnes', (req, res) => { res.json(Object.values(personnes)); });
app.get('/api/v1/personnes/:npi', (req, res) => { const p = personnes[req.params.npi]; if (!p) return res.status(404).json({error:'Non trouvé'}); res.json(p); });
app.get('/api/v1/anip/personnes/:npi', certAuth, (req, res) => {
  sendLog('IN', 'GET', `/api/v1/anip/personnes/${req.params.npi}`, '-', `Requete de "${req.clientCN}" — NPI ${req.params.npi}`);
  const p = personnes[req.params.npi];
  if (!p) {
    sendLog('REJECT', 'GET', `/api/v1/anip/personnes/${req.params.npi}`, 404, 'NPI inconnu');
    return res.status(404).json({ error: 'NPI inconnu' });
  }
  sendLog('SUCCESS', 'GET', `/api/v1/anip/personnes/${req.params.npi}`, 200, `${p.prenoms} ${p.nom}`);
  const { npi, ...evidence } = p;
  res.json(evidence);
});
app.post('/api/v1/personnes', (req, res) => { const {npi,nom,prenoms,date_naissance,nationalite}=req.body; if(!npi||!nom||!prenoms||!date_naissance||!nationalite) return res.status(400).json({error:'Champs requis manquants'}); if(personnes[npi]) return res.status(409).json({error:'NPI déjà existant'}); personnes[npi]={npi,nom,prenoms,date_naissance,nationalite}; save(); res.status(201).json(personnes[npi]); });
app.put('/api/v1/personnes/:npi', (req, res) => { const p=personnes[req.params.npi]; if(!p) return res.status(404).json({error:'Non trouvé'}); Object.assign(p,req.body); save(); res.json(p); });
app.delete('/api/v1/personnes/:npi', (req, res) => { if(!personnes[req.params.npi]) return res.status(404).json({error:'Non trouvé'}); delete personnes[req.params.npi]; save(); res.json({ok:true}); });

app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/', (req, res) => { res.redirect('/admin'); });

const httpsServer = https.createServer({
  cert: serverCert, key: serverKey, ca: caCert,
  requestCert: true, rejectUnauthorized: false
}, app);

httpsServer.listen(PORT, () => {
  console.log(`[ANIP] HTTPS Port ${PORT} — Admin: https://localhost:${PORT}`);
  console.log(`[ANIP] Certificat serveur: CN=ANIP-Registry`);
  console.log(`[ANIP] Certificats clients acceptés: Portal-Concours`);
  console.log(`[ANIP] Certificat client sortant: ANIP-Registry → Justice, DGES`);
});
