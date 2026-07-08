const { test, expect } = require('@playwright/test');

const PORTAL = 'https://localhost:3000';
const ANIP = 'https://localhost:3001';
const JUSTICE = 'https://localhost:3002';
const DGES = 'https://localhost:3003';

test.describe('Portal - Accueil', () => {
  test('loads with navbar and hero', async ({ page }) => {
    await page.goto(PORTAL);
    await expect(page.locator('.navbar-brand h1')).toContainText('Concours de Bourses');
    await expect(page.locator('.hero h2')).toContainText('Concours National');
    await expect(page.locator('.navbar-links a')).toHaveCount(4);
  });

  test('has info cards', async ({ page }) => {
    await page.goto(PORTAL);
    await expect(page.locator('.info-card')).toHaveCount(4);
  });

  test('has process flow', async ({ page }) => {
    await page.goto(PORTAL);
    await expect(page.locator('.process-flow')).toBeVisible();
    await expect(page.locator('.process-step')).toHaveCount(6);
  });

  test('can navigate to candidature', async ({ page }) => {
    await page.goto(PORTAL);
    await page.locator('.navbar-links a:has-text("Candidature")').click();
    await expect(page.locator('#page-candidature')).toHaveClass(/active/);
    await expect(page.locator('#npi')).toBeVisible();
    await expect(page.locator('#diplome')).toBeVisible();
  });

  test('can navigate to monitor', async ({ page }) => {
    await page.goto(PORTAL);
    await page.locator('.navbar-links a:has-text("Monitor")').click();
    await expect(page.locator('#page-monitor')).toHaveClass(/active/);
  });

  test('can navigate to architecture', async ({ page }) => {
    await page.goto(PORTAL);
    await page.locator('.navbar-links a:has-text("Architecture")').click();
    await expect(page.locator('#page-architecture')).toHaveClass(/active/);
  });

  test('hero is hidden on non-accueil pages', async ({ page }) => {
    await page.goto(PORTAL);
    await page.locator('.navbar-links a:has-text("Candidature")').click();
    await expect(page.locator('#hero-section')).toBeHidden();
  });
});

test.describe('Portal - Candidature', () => {
  test('has NPI and diplome form', async ({ page }) => {
    await page.goto(PORTAL);
    await page.locator('.navbar-links a:has-text("Candidature")').click();
    await expect(page.locator('#npi')).toBeVisible();
    await expect(page.locator('#diplome')).toBeVisible();
    await expect(page.locator('#submitBtn')).toBeVisible();
  });

  test('has mini log', async ({ page }) => {
    await page.goto(PORTAL);
    await page.locator('.navbar-links a:has-text("Candidature")').click();
    await expect(page.locator('#mini-log')).toBeVisible();
  });

  test('has footer', async ({ page }) => {
    await page.goto(PORTAL);
    await expect(page.locator('.footer')).toBeVisible();
  });
});

test.describe('ANIP Admin', () => {
  test('loads with sidebar', async ({ page }) => {
    await page.goto(ANIP + '/admin.html');
    await expect(page.locator('.sidebar-brand h2')).toHaveText('ANIP');
    await expect(page.locator('.sidebar-nav button')).toHaveCount(2);
  });

  test('shows stats', async ({ page }) => {
    await page.goto(ANIP + '/admin.html');
    await expect(page.locator('#stat-total')).toBeVisible();
    await expect(page.locator('#stat-nationaux')).toBeVisible();
    await expect(page.locator('#stat-etrangers')).toBeVisible();
  });

  test('can add a person', async ({ page }) => {
    const ts = Date.now();
    await page.goto(ANIP + '/admin.html');
    await page.fill('#f-npi', String(ts).padStart(14, '1'));
    await page.fill('#f-nom', 'TEST' + ts);
    await page.fill('#f-prenoms', 'User');
    await page.fill('#f-date', '1990-01-01');
    await page.fill('#f-nationalite', 'Beninoise');
    await page.click('button[type="submit"]');
    await expect(page.locator('.msg.ok')).toBeVisible({ timeout: 8000 });
  });

  test('can navigate to registre and see data', async ({ page }) => {
    await page.goto(ANIP + '/admin.html');
    await page.evaluate(() => showPage('registre', document.querySelectorAll('.sidebar-nav button')[1]));
    await expect(page.locator('#page-registre')).toHaveClass(/active/);
    await expect(page.locator('.data-table')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Justice Admin', () => {
  test('loads with sidebar', async ({ page }) => {
    await page.goto(JUSTICE + '/admin.html');
    await expect(page.locator('.sidebar-brand h2')).toHaveText('Justice');
  });

  test('shows stats', async ({ page }) => {
    await page.goto(JUSTICE + '/admin.html');
    await expect(page.locator('#stat-total')).toBeVisible();
    await expect(page.locator('#stat-vierge')).toBeVisible();
  });

  test('can add a casier', async ({ page }) => {
    const ts = Date.now();
    await page.goto(JUSTICE + '/admin.html');
    await page.fill('#f-npi', String(ts).padStart(14, '1'));
    await page.selectOption('#f-statut', 'VIERGE');
    await page.fill('#f-ref', 'CJ-' + ts);
    await page.click('button[type="submit"]');
    await expect(page.locator('.msg.ok')).toBeVisible({ timeout: 8000 });
  });
});

test.describe('DGES Admin', () => {
  test('loads with sidebar', async ({ page }) => {
    await page.goto(DGES + '/admin.html');
    await expect(page.locator('.sidebar-brand h2')).toHaveText('DGES');
  });

  test('shows stats', async ({ page }) => {
    await page.goto(DGES + '/admin.html');
    await expect(page.locator('#stat-total')).toBeVisible();
    await expect(page.locator('#stat-licence')).toBeVisible();
  });

  test('can add a diploma', async ({ page }) => {
    const ts = Date.now();
    await page.goto(DGES + '/admin.html');
    await page.fill('#f-numero', 'DIP-TEST-' + ts);
    await page.fill('#f-npi', String(ts).padStart(14, '1'));
    await page.selectOption('#f-grade', 'Master');
    await page.fill('#f-filiere', 'Test Filiere');
    await page.fill('#f-annee', '2026');
    await page.click('button[type="submit"]');
    await expect(page.locator('.msg.ok')).toBeVisible({ timeout: 8000 });
  });
});

test.describe('Full Candidature Flow', () => {
  test('can submit a candidature and see result', async ({ page }) => {
    await page.goto(PORTAL);
    await page.locator('.navbar-links a:has-text("Candidature")').click();
    await page.fill('#npi', '11111111111111');
    await page.fill('#diplome', 'DIP-LIC-2026-001');
    await page.click('#submitBtn');
    await expect(page.locator('#result')).toHaveClass(/error|success/, { timeout: 20000 });
  });
});
