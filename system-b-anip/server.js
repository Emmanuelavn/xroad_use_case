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
const LOG_DISABLED = process.env.LOG_DISABLED === 'true';
const TRUST_XROAD = process.env.TRUST_XROAD === 'true';
const ALLOW_DIRECT_API = process.env.ALLOW_DIRECT_API === 'true';
const HTTP_ONLY = process.env.HTTP_ONLY === 'true';

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
  const entry = { source: 'B-ANIP', direction, method, path: p, status, detail, time: new Date().toISOString() };
  console.log(`[FLOW] ${JSON.stringify(entry)}`);
  if (LOG_DISABLED) return;
  const data = JSON.stringify(entry);
  try {
    const req = https.request({ hostname: LOG_HOST, port: LOG_PORT, path: '/api/logs/push', method: 'POST', ca: caCert, rejectUnauthorized: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { res.resume(); });
    req.on('error', (e) => { console.error(`[ANIP] sendLog ERROR: ${e.message}`); }); req.write(data); req.end();
  } catch(e) { console.error(`[ANIP] sendLog EXCEPTION: ${e.message}`); }
}

function certAuth(req, res, next) {
  const trustedClient = req.header('Uxp-Client') || req.header('X-Road-Client');
  if (TRUST_XROAD && trustedClient) {
    req.clientCN = trustedClient;
    return next();
  }
  if (ALLOW_DIRECT_API) {
    req.clientCN = 'DIRECT_API';
    return next();
  }
  if (req.path.startsWith('/admin') || req.path === '/' || req.path === '/favicon.ico') return next();
  const cert = typeof req.socket.getPeerCertificate === 'function'
    ? req.socket.getPeerCertificate()
    : null;
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

function logXroadExchange(req, res, next) {
  const startedAt = Date.now();
  const forwardedFor = req.header('X-Forwarded-For');
  const origin = forwardedFor?.split(',')[0].trim()
    || req.header('X-Real-IP')
    || req.socket.remoteAddress
    || 'unknown';
  const context = {
    origin,
    caller: req.header('Uxp-Client') || req.header('X-Road-Client') || 'DIRECT_API',
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
    body: req.body
  };
  console.log(`[XROAD][ANIP][IN] ${JSON.stringify({ time: new Date().toISOString(), ...context })}`);
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    console.log(`[XROAD][ANIP][OUT] ${JSON.stringify({ time: new Date().toISOString(), ...context, status: res.statusCode, duration_ms: Date.now() - startedAt, body })}`);
    return sendJson(body);
  };
  next();
}

app.use('/api/v1/anip', logXroadExchange);

// HTTPS call with client certificate
function callServiceHTTPS(method, url, body) {
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
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

if (HTTP_ONLY) {
  http.createServer(app).listen(PORT, () => {
    console.log(`[ANIP] HTTP Port ${PORT} — backend interne X-Road`);
  });
} else {
  const httpsServer = https.createServer({
    cert: serverCert, key: serverKey, ca: caCert,
    requestCert: true, rejectUnauthorized: false
  }, app);

  httpsServer.listen(PORT, () => {
    console.log(`[ANIP] HTTPS Port ${PORT} — Admin: https://localhost:${PORT}`);
    console.log(`[ANIP] Certificat serveur: CN=ANIP-Registry`);
    console.log(`[ANIP] Certificats clients acceptés: Portal-Concours`);
    console.log(`[ANIP] Certificat client sortant: ANIP-Registry -> Justice, DGES`);
  });
}
