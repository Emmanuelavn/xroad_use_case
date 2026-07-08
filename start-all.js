const { execSync, spawn } = require('child_process');
const path = require('path');

const systems = [
  { name: 'C - Justice', dir: 'system-c-justice' },
  { name: 'D - DGES', dir: 'system-d-dges' },
  { name: 'B - ANIP', dir: 'system-b-anip' },
  { name: 'A - Portail', dir: 'system-a-portal' }
];

console.log('=== Nettoyage des anciens serveurs ===\n');
try {
  execSync('taskkill /F /IM node.exe 2>nul', { stdio: 'ignore' });
  execSync('timeout /t 1 /nobreak >nul', { stdio: 'ignore' });
  console.log('Anciens processus node tués.\n');
} catch (e) {}

console.log('=== Installation des dépendances ===\n');
systems.forEach(s => {
  console.log(`Installation ${s.name}...`);
  execSync('npm install', { cwd: path.join(__dirname, s.dir), stdio: 'inherit' });
});

console.log('\n=== Démarrage des serveurs ===\n');

const processes = systems.map(s => {
  const p = spawn('node', ['server.js'], { cwd: path.join(__dirname, s.dir) });
  p.stdout.on('data', d => process.stdout.write(`[${s.name}] ${d}`));
  p.stderr.on('data', d => process.stderr.write(`[${s.name}] ${d}`));
  return p;
});

process.on('SIGINT', () => {
  console.log('\nArrêt des serveurs...');
  processes.forEach(p => p.kill());
  process.exit();
});

console.log('\nTous les serveurs sont en cours de démarrage...');
console.log('Interface web : http://localhost:3000');
console.log('Ctrl+C pour arrêter tous les serveurs\n');
