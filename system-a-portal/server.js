const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3000;
const CERTS_DIR = path.join(__dirname, 'certs');

const serverCert = fs.readFileSync(path.join(CERTS_DIR, 'server-cert.pem'));
const serverKey = fs.readFileSync(path.join(CERTS_DIR, 'server-key.pem'));
const caCert = fs.readFileSync(path.join(CERTS_DIR, 'ca-cert.pem'));
const clientCert = fs.readFileSync(path.join(CERTS_DIR, 'client-cert.pem'));
const clientKey = fs.readFileSync(path.join(CERTS_DIR, 'client-key.pem'));

const inscriptions = [];
const paiements = [];
const convocations = [];
let nextId = 1;
let nextConvocId = 1;

const logClients = [];
const logs = [];
let logId = 1;

function addLog(source, direction, method, path, status, detail) {
  const entry = { id: logId++, source, direction, method, path, status, detail, time: new Date().toISOString() };
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  logClients.forEach(res => res.write(`data: ${JSON.stringify(entry)}\n\n`));
}

app.post('/api/logs/push', (req, res) => {
  const entry = { id: logId++, ...req.body };
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  console.log(`[LOG] ${entry.source} ${entry.direction} ${entry.path} — push vers ${logClients.length} client(s) SSE`);
  logClients.forEach(c => c.write(`data: ${JSON.stringify(entry)}\n\n`));
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => { res.json(logs.slice(-100)); });

app.get('/api/logs/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  logClients.push(res);
  console.log(`[SSE] Nouveau client connecte — total: ${logClients.length}`);
  const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch(e) {} }, 15000);
  req.on('close', () => { clearInterval(keepalive); const i = logClients.indexOf(res); if (i >= 0) logClients.splice(i, 1); console.log(`[SSE] Client deconnecte — total: ${logClients.length}`); });
});

// HTTPS call to ANIP with client certificate
function callANIP(npi, numero_diplome) {
  addLog('A-PORTAL', 'OUT', 'POST', '/api/v1/concours/verifier', '-', `NPI=${npi} Diplôme=${numero_diplome} (certificat client Portal-Concours)`);
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ npi, numero_diplome });
    const options = {
      hostname: 'localhost', port: 3001, path: '/api/v1/concours/verifier', method: 'POST',
      cert: clientCert, key: clientKey, ca: caCert, rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let serverCN = 'ANIP';
        try { const ci = res.socket?.getPeerCertificate(); if (ci?.subject) serverCN = ci.subject.CN; } catch(e) {}
        addLog('A-PORTAL', 'IN', 'POST', '/api/v1/concours/verifier', res.statusCode, `Réponse de ${serverCN} — ${res.statusCode === 200 ? 'OK' : 'FAIL'}`);
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function fetchSecure(port, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost', port, path, method: 'GET',
      cert: clientCert, key: clientKey, ca: caCert, rejectUnauthorized: false,
      headers: {}
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve([]); } });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

app.post('/api/v1/concours/inscrire', async (req, res) => {
  const { npi, numero_diplome } = req.body;
  if (!npi || !numero_diplome) return res.status(400).json({ error: 'npi et numero_diplome requis' });

  const exist = inscriptions.find(i => i.npi === npi);
  if (exist) {
    const paiement = paiements.find(p => p.npi === npi);
    if (paiement) {
      const convoc = convocations.find(c => c.npi === npi);
      return res.status(200).json({ succes: true, deja_inscrit: true, paiement_valide: true, convocation: convoc || null });
    }
    return res.status(200).json({ succes: true, deja_inscrit: true, paiement_valide: false, motif: 'Inscription existe, paiement en attente' });
  }

  let anipResponse;
  try { anipResponse = await callANIP(npi, numero_diplome); }
  catch (e) { return res.status(503).json({ error: 'Service ANIP indisponible.' }); }

  if (anipResponse.status !== 200 || !anipResponse.body.succes) {
    return res.status(anipResponse.status || 403).json({ succes: false, motif: anipResponse.body.motif || 'Vérification échouée' });
  }

  const c = anipResponse.body.candidat;
  inscriptions.push({ id_inscription: nextId++, npi, nom_complet: `${c.prenoms} ${c.nom}`, numero_diplome, date_inscription: new Date().toISOString() });
  addLog('A-PORTAL', 'SUCCESS', 'POST', '/api/v1/concours/inscrire', 200, `Vérification ${c.prenoms} ${c.nom} OK`);

  res.json({
    succes: true, message: `Vérification réussie pour ${c.prenoms} ${c.nom}. Vous pouvez maintenant procéder au paiement des frais de quittance.`,
    candidat: anipResponse.body.candidat, casier: anipResponse.body.casier, diplome: anipResponse.body.diplome
  });
});

app.post('/api/v1/paiement', (req, res) => {
  const { npi, methode } = req.body;
  if (!npi) return res.status(400).json({ error: 'npi requis' });

  const inscription = inscriptions.find(i => i.npi === npi);
  if (!inscription) return res.status(404).json({ error: 'Inscription non trouvée. Veuillez d\'abord vérifier votre identité.' });

  if (paiements.find(p => p.npi === npi)) {
    return res.status(200).json({ succes: true, message: 'Paiement déjà effectué', deja_paye: true });
  }

  const montant = 10000;
  const ref_paiement = `QP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const paiement = {
    id: nextId++, npi, montant, methode: methode || 'Mobile Money',
    reference: ref_paiement, date_paiement: new Date().toISOString(), statut: 'PAYÉ'
  };
  paiements.push(paiement);

  const numConvoc = `CONV-${new Date().getFullYear()}-C${String(nextConvocId++).padStart(4, '0')}`;
  const convocation = {
    numero_convocation: numConvoc, npi,
    nom_complet: inscription.nom_complet, numero_diplome: inscription.numero_diplome,
    date_epreuve: '2026-07-25', heure_epreuve: '08:00',
    lieu: 'Centre d\'Examen de l\'Université d\'Abomey-Calavi — Amphi C1',
    matieres: ['Mathématiques', 'Informatique Générale', 'Logique et Raisonnement', 'Culture Générale'],
    duree: '3 heures', montant_paye: montant, reference_paiement: ref_paiement
  };
  convocations.push(convocation);

  addLog('A-PORTAL', 'SUCCESS', 'POST', '/api/v1/paiement', 200, `Paiement ${montant} FCFA — ${inscription.nom_complet}`);

  res.json({ succes: true, message: `Paiement de ${montant.toLocaleString()} FCFA confirmé.`, paiement, convocation });
});

app.get('/api/v1/convocation/:npi', (req, res) => {
  const convoc = convocations.find(c => c.npi === req.params.npi);
  if (!convoc) return res.status(404).json({ error: 'Convocation non trouvée. Paiement en attente.' });
  res.json(convoc);
});

app.get('/api/v1/inscriptions', (req, res) => { res.json(inscriptions); });
app.get('/api/v1/paiements', (req, res) => { res.json(paiements); });

app.get('/api/v1/all-data', async (req, res) => {
  const [personnes, casiers, diplomes, inscriptionsData, paiementsData] = await Promise.all([
    fetchSecure(3001, '/api/v1/personnes'),
    fetchSecure(3002, '/api/v1/casiers'),
    fetchSecure(3003, '/api/v1/diplomes'),
    Promise.resolve(inscriptions),
    Promise.resolve(paiements)
  ]);
  res.json({ anip: personnes, justice: casiers, dges: diplomes, portal: inscriptionsData, paiements: paiementsData });
});

// HTTPS server (no client cert required for browser users)
const httpsServer = https.createServer({
  cert: serverCert, key: serverKey, ca: caCert
}, app);

httpsServer.listen(PORT, () => {
  console.log(`[Portail] HTTPS Port ${PORT} — https://localhost:${PORT}`);
  console.log(`[Portail] Certificat serveur: CN=Portal-Concours`);
  console.log(`[Portail] Certificat client sortant: Portal-Concours → ANIP`);
});
