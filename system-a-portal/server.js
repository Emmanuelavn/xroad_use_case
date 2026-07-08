const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const CERTS_DIR = path.join(__dirname, 'certs');
const XROAD_BASE_URL = process.env.XROAD_BASE_URL;
const XROAD_CLIENT = process.env.XROAD_CLIENT || 'BJ/GOV/PORTAL/CONCOURS';
const OOTS_DIR = path.join(__dirname, 'oots-lite');
const evidenceBroker = JSON.parse(fs.readFileSync(path.join(OOTS_DIR, 'evidence-broker.json'), 'utf8'));
const dataServiceDirectory = JSON.parse(fs.readFileSync(path.join(OOTS_DIR, 'data-service-directory.json'), 'utf8'));
const semanticRepository = JSON.parse(fs.readFileSync(path.join(OOTS_DIR, 'semantic-repository.json'), 'utf8'));

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

function callJsonOverHttp(method, targetUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;
    const postData = body ? JSON.stringify(body) : null;
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
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function formatTemplate(value, context) {
  if (typeof value === 'string') {
    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => context[key] ?? '');
  }
  if (Array.isArray(value)) return value.map(item => formatTemplate(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, formatTemplate(item, context)]));
  }
  return value;
}

function getField(object, field) {
  return field.split('.').reduce((current, part) => current?.[part], object);
}

function evaluateRule(rule, evidence) {
  const actual = getField(evidence, rule.field);
  if (rule.operator === 'equals') return actual === rule.value;
  throw new Error(`Operateur de regle non supporte: ${rule.operator}`);
}

function hasRequiredResponseFields(evidenceType, payload) {
  const definition = semanticRepository.evidence_types[evidenceType];
  if (!definition) return true;
  return definition.required_response_fields.every(field => getField(payload, field) !== undefined);
}

async function collectEvidence(evidenceType, context) {
  const service = dataServiceDirectory.data_services[evidenceType];
  if (!service) throw new Error(`Aucun data service pour la preuve ${evidenceType}`);

  const restPath = formatTemplate(service.path, context);
  const body = service.body ? formatTemplate(service.body, context) : null;
  const target = `${XROAD_BASE_URL}/r1/${service.service_id}${restPath}`;
  addLog('A-PORTAL', 'OUT', service.method, restPath, '-', `OOTS-lite ${evidenceType} -> ${service.provider}`);
  const response = await callJsonOverHttp(service.method, target, body, { 'X-Road-Client': XROAD_CLIENT });
  addLog('A-PORTAL', 'IN', service.method, restPath, response.status, `Preuve ${evidenceType} de ${service.provider}`);

  if (response.status < 200 || response.status >= 300) {
    return {
      evidence_type: evidenceType,
      provider: service.provider,
      valid: false,
      status: response.status,
      motif: response.body?.motif || response.body?.error || `Preuve ${evidenceType} indisponible`
    };
  }

  if (!hasRequiredResponseFields(evidenceType, response.body)) {
    return {
      evidence_type: evidenceType,
      provider: service.provider,
      valid: false,
      status: 502,
      motif: `Contrat semantique incomplet pour ${evidenceType}`
    };
  }

  return {
    evidence_type: evidenceType,
    provider: service.provider,
    valid: true,
    status: response.status,
    body: response.body
  };
}

async function evaluateConcoursEligibility(npi, numero_diplome) {
  const procedure = evidenceBroker.procedures['concours-bourses-master-2026'];
  const context = { npi, numero_diplome };
  const collected = {};
  const checks = [];

  for (const evidenceType of procedure.required_evidence_types) {
    const result = await collectEvidence(evidenceType, context);
    collected[evidenceType] = result.body;
    checks.push({ evidence_type: evidenceType, provider: result.provider, status: result.valid ? 'valid' : 'invalid' });
    if (!result.valid) return { status: result.status || 403, body: { succes: false, motif: result.motif, checks } };

    const rule = procedure.rules.find(item => item.evidence_type === evidenceType);
    if (rule && !evaluateRule(rule, result.body)) {
      return { status: 403, body: { succes: false, motif: rule.failure_message, checks } };
    }
  }

  const personne = collected['identity-nationality'];
  const casier = collected['criminal-record'];
  const diplome = collected['diploma-authenticity'];
  return {
    status: 200,
    body: {
      succes: true,
      candidat: { npi, nom: personne.nom, prenoms: personne.prenoms, nationalite: personne.nationalite },
      casier: { statut: casier.statut_casier },
      diplome: { authentique: diplome.authentique, filiere: diplome.filiere, grade: diplome.intitule_grade },
      checks
    }
  };
}

// HTTPS call to ANIP with client certificate in local mode, or OOTS-lite evidence collection over X-Road in container mode.
function callANIP(npi, numero_diplome) {
  addLog('A-PORTAL', 'OUT', 'POST', '/api/v1/concours/verifier', '-', `NPI=${npi} Diplôme=${numero_diplome} (${XROAD_BASE_URL ? 'OOTS-lite Evidence Requester' : 'certificat client Portal-Concours'})`);
  if (XROAD_BASE_URL) {
    return evaluateConcoursEligibility(npi, numero_diplome);
  }
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
  if (XROAD_BASE_URL) {
    const serviceByPort = {
      3001: 'BJ/GOV/ANIP/REGISTRY/anip',
      3002: 'BJ/GOV/JUSTICE/CASIER/justice',
      3003: 'BJ/GOV/DGES/DIPLOMES/dges'
    };
    const serviceId = serviceByPort[port];
    if (!serviceId) return Promise.resolve([]);
    return callJsonOverHttp('GET', `${XROAD_BASE_URL}/r1/${serviceId}${path}`, null, { 'X-Road-Client': XROAD_CLIENT })
      .then((response) => Array.isArray(response.body) ? response.body : []);
  }
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

  const c = { npi, ...anipResponse.body.candidat };
  inscriptions.push({ id_inscription: nextId++, npi, nom_complet: `${c.prenoms} ${c.nom}`, numero_diplome, date_inscription: new Date().toISOString() });
  addLog('A-PORTAL', 'SUCCESS', 'POST', '/api/v1/concours/inscrire', 200, `Vérification ${c.prenoms} ${c.nom} OK`);

  res.json({
    succes: true, message: `Vérification réussie pour ${c.prenoms} ${c.nom}. Vous pouvez maintenant procéder au paiement des frais de quittance.`,
    candidat: c, casier: anipResponse.body.casier, diplome: anipResponse.body.diplome
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
