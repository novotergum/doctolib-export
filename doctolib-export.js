// doctolib-export.js
// Automatischer Doctolib-Statistik-Export (Termine) via Playwright/Chromium

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Pflicht-ENV
const DOCTOLIB_USER = process.env.DOCTOLIB_USER;
const DOCTOLIB_PASS = process.env.DOCTOLIB_PASS;
const DOCTOLIB_ORG_ID = process.env.DOCTOLIB_ORG_ID; // z.B. 263702

// Login-URL (bei dir meistens /signin; per ENV überschreibbar)
const DOCTOLIB_LOGIN_URL =
  process.env.DOCTOLIB_LOGIN_URL || 'https://pro.doctolib.de/signin';

// User-Agent, damit der Runner möglichst wie dein Browser aussieht
const DOCTOLIB_UA =
  process.env.DOCTOLIB_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Export-Verzeichnis
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, 'exports');

// Statistik-Konfiguration
const DATE_FILTERING = process.env.DATE_FILTERING || 'start_date'; // 'start_date' = wahrgenommen, 'created_at' = gebucht
const PRIMARY_GROUP = process.env.PRIMARY_GROUP || 'agenda';       // 'agenda' = Terminkalender
const SECONDARY_GROUP = process.env.SECONDARY_GROUP || '';         // '' = keine zweite Gruppierung
const EXCLUDE_STATUSES = (process.env.EXCLUDE_STATUSES || 'deleted')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!DOCTOLIB_USER || !DOCTOLIB_PASS || !DOCTOLIB_ORG_ID) {
  console.error('Fehlende ENV: DOCTOLIB_USER, DOCTOLIB_PASS und DOCTOLIB_ORG_ID müssen gesetzt sein.');
  process.exit(1);
}

// letzter vollständiger Monat
function lastMonthRange() {
  const now = new Date();
  const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastLastMonth = new Date(firstThisMonth.getTime() - 1);
  const firstLastMonth = new Date(lastLastMonth.getFullYear(), lastLastMonth.getMonth(), 1);
  const fmt = d => d.toISOString().slice(0, 10); // YYYY-MM-DD
  return { start: fmt(firstLastMonth), end: fmt(lastLastMonth) };
}

// sicherstellen, dass wir wirklich auf der Login-Maske sind
async function ensureLoginForm(page) {
  const emailSelector = 'input[autocomplete="username"], input[type="email"]';
  const emailLocator = page.locator(emailSelector).first();

  try {
    await emailLocator.waitFor({ timeout: 10000 });
    return; // Formular ist schon da
  } catch (_) {
    console.log('Kein Login-Input sichtbar – versuche, Login-Link zu klicken …');
  }

  const loginLink = page
    .locator(
      [
        'a[href*="signin"]',
        'a[href*="login"]',
        'a:has-text("Einloggen")',
        'a:has-text("Login")',
        'button:has-text("Einloggen")',
        'button:has-text("Login")'
      ].join(', ')
    )
    .first();

  if (await loginLink.isVisible().catch(() => false)) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      loginLink.click(),
    ]);
  } else {
    console.log('Kein Login-Link gefunden; bleibe auf aktueller Seite.');
  }

  // nach Klick noch einmal auf das Formular warten
  await page.locator(emailSelector).first().waitFor({ timeout: 20000 });
}

// Login auf Doctolib
async function login(page) {
  console.log('Gehe zur Login-Seite …', DOCTOLIB_LOGIN_URL);
  await page.goto(DOCTOLIB_LOGIN_URL, { waitUntil: 'networkidle' });
  page.setDefaultTimeout(60000);

  // Cookie-/Consent-Banner (best effort)
  try {
    const consentButton = page
      .getByRole('button', { name: /akzeptieren|zustimmen|alle akzeptieren/i })
      .first();
    if (await consentButton.isVisible()) {
      console.log('Klicke Cookie/Consent-Button …');
      await consentButton.click();
      await page.waitForTimeout(1000);
    }
  } catch (_) {
    // kein Banner: ok
  }

  // sicherstellen, dass das Login-Formular wirklich da ist
  await ensureLoginForm(page);

  // E-Mail / Username
  const emailLocator = page
    .locator('input[autocomplete="username"], input[type="email"]')
    .first();

  console.log('Fülle E-Mail …');
  await emailLocator.fill(DOCTOLIB_USER);

  // Passwort
  const passwordLocator = page
    .locator('input[autocomplete="current-password"], input[type="password"]')
    .first();

  console.log('Fülle Passwort …');
  await passwordLocator.fill(DOCTOLIB_PASS);

  // Submit
  const submitButton = page
    .locator(
      [
        'button[type="submit"]',
        'button:has-text("Anmelden")',
        'button:has-text("Einloggen")',
        'button:has-text("Login")',
      ].join(', ')
    )
    .first();

  console.log('Sende Login-Formular ab …');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    submitButton.click(),
  ]);

  console.log('Login abgeschlossen, aktuelle URL:', page.url());
}

// Statistik öffnen
async function openStats(page, start, end) {
  const url = `https://pro.doctolib.de/configuration/statistics/queries?organization_id=${DOCTOLIB_ORG_ID}`;
  console.log('Öffne Statistik-Seite:', url);
  await page.goto(url, { waitUntil: 'networkidle' });

  console.log(`Setze Zeitraum: ${start} bis ${end}`);
  await page.fill('#from', start);
  await page.fill('#to', end);
  await page.waitForTimeout(1500);
}

// Statistik-Konfiguration
async function configureStats(page) {
  console.log('Konfiguriere Statistik …');

  await page.selectOption('#table', 'appointment');            // Termine
  await page.selectOption('#date_filtering', DATE_FILTERING);  // wahrgenommen / gebucht
  await page.selectOption('#appointment_group', PRIMARY_GROUP);
  await page.selectOption('#appointment_second_group', SECONDARY_GROUP || '');
  await page.selectOption('#appointment_select', 'appointment_count');

  const allStatusValues = [
    'done',
    'no_show',
    'no_show_but_ok',
    'waiting',
    'confirmed',
    'deleted',
    'in_progress',
    'rescheduled',
    'suspended',
  ];
  const excludeSet = new Set(EXCLUDE_STATUSES);
  console.log(
    'Auszuschließende Status:',
    Array.from(excludeSet).join(', ') || '(keine)'
  );

  for (const value of allStatusValues) {
    const selector = `input[name="status_filters[]"][value="${value}"]`;
    const el = await page.$(selector);
    if (!el) continue;

    const shouldExclude = excludeSet.has(value);
    const checked = await el.isChecked();

    if (shouldExclude && !checked) {
      await el.check();
    } else if (!shouldExclude && checked) {
      await el.uncheck();
    }
  }

  await page.waitForTimeout(1000);
}

// Export anstoßen
async function exportStats(page, start, end) {
  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }

  console.log('Starte Export …');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('input[name="csv"]'), // Button „Exportieren“
  ]);

  const suggested = await download.suggestedFilename();
  const fileName = `doctolib_${start}_${end}_${suggested}`;
  const filePath = path.join(EXPORT_DIR, fileName);

  await download.saveAs(filePath);
  console.log('Export gespeichert:', filePath);
}

// Main
(async () => {
  const { start, end } = lastMonthRange();
  console.log(`Zeitraum (letzter Monat): ${start} – ${end}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: DOCTOLIB_UA,
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  try {
    await login(page);
    await openStats(page, start, end);
    await configureStats(page);
    await exportStats(page, start, end);
    console.log('Fertig.');
  } catch (e) {
    console.error('Fehler im Doctolib-Export:', e);

    try {
      if (!fs.existsSync(EXPORT_DIR)) {
        fs.mkdirSync(EXPORT_DIR, { recursive: true });
      }
      const screenshotPath = path.join(EXPORT_DIR, 'error-login.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log('Fehler-Screenshot gespeichert unter:', screenshotPath);

      const htmlSnippet = (await page.content()).slice(0, 2000);
      console.log('Aktuelle URL:', page.url());
      console.log('HTML-Ausschnitt:\n', htmlSnippet);
    } catch (screenshotErr) {
      console.error('Konnte Screenshot/HTML nicht speichern:', screenshotErr);
    }

    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
