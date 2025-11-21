// doctolib-export.js
// Automatischer Doctolib-Statistik-Export (Termine) via Playwright/Chromium

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---------- ENV & Konstanten ----------

const DOCTOLIB_USER = process.env.DOCTOLIB_USER;
const DOCTOLIB_PASS = process.env.DOCTOLIB_PASS;
const DOCTOLIB_ORG_ID = process.env.DOCTOLIB_ORG_ID; // z.B. 263702

if (!DOCTOLIB_USER || !DOCTOLIB_PASS || !DOCTOLIB_ORG_ID) {
  console.error(
    'Fehlende ENV: DOCTOLIB_USER, DOCTOLIB_PASS und DOCTOLIB_ORG_ID müssen gesetzt sein.'
  );
  process.exit(1);
}

const DOCTOLIB_LOGIN_URL =
  process.env.DOCTOLIB_LOGIN_URL || 'https://pro.doctolib.de/signin';

const DOCTOLIB_UA =
  process.env.DOCTOLIB_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, 'exports');

// Statistik-Konfiguration
const DATE_FILTERING = process.env.DATE_FILTERING || 'start_date'; // 'start_date' (wahrgenommen) | 'created_at' (gebucht)
const PRIMARY_GROUP = process.env.PRIMARY_GROUP || 'agenda'; // Terminkalender
const SECONDARY_GROUP = process.env.SECONDARY_GROUP || '';
const EXCLUDE_STATUSES = (process.env.EXCLUDE_STATUSES || 'deleted')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- Hilfsfunktionen ----------

function lastMonthRange() {
  const now = new Date();
  const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastLastMonth = new Date(firstThisMonth.getTime() - 1);
  const firstLastMonth = new Date(
    lastLastMonth.getFullYear(),
    lastLastMonth.getMonth(),
    1
  );
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(firstLastMonth), end: fmt(lastLastMonth) };
}

// ---------- Login-Flow ----------

async function maybeAcceptCookies(page) {
  try {
    const btn = page
      .getByRole('button', { name: /akzeptieren|zustimmen|alle akzeptieren/i })
      .first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Cookie- / Consent-Button gefunden → klicke …');
      await btn.click();
      await page.waitForTimeout(1000);
    }
  } catch {
    // kein Banner, kein Problem
  }
}

async function login(page) {
  console.log('Gehe zur Login-Seite …', DOCTOLIB_LOGIN_URL);
  await page.goto(DOCTOLIB_LOGIN_URL, { waitUntil: 'networkidle' });
  page.setDefaultTimeout(60000);

  await maybeAcceptCookies(page);

  // --- Schritt 1: E-Mail-Maske (wenn vorhanden) ---

  const emailInput = page
    .locator('input[autocomplete="username"], input[type="email"]')
    .first();

  if (await emailInput.isVisible().catch(() => false)) {
    console.log('E-Mail-Maske sichtbar → fülle E-Mail.');

    await emailInput.fill(DOCTOLIB_USER);

    // Button im gleichen Form (Weiter / Einloggen)
    const emailForm = emailInput.locator('xpath=ancestor::form[1]');
    const emailSubmit = emailForm
      .locator(
        'button[type="submit"], button:has-text("Weiter"), button:has-text("Einloggen")'
      )
      .first();

    await Promise.all([
      // Doctolib navigiert teils „soft“ → Fallback auf Timeout
      emailSubmit.click(),
      page
        .waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 })
        .catch(() => page.waitForTimeout(2000)),
    ]);

    console.log('Weiter nach E-Mail, aktuelle URL:', page.url());
  } else {
    console.log('Keine E-Mail-Maske sichtbar → vermutlich direkt Passwort-Schritt.');
  }

  // --- Schritt 2: Passwort-Maske mit Konto-Auswahl ---

  const passwordInput = page
    .locator(
      'input[name="password"][autocomplete="current-password"], ' +
        'input[type="password"][autocomplete="current-password"], ' +
        'input#password'
    )
    .first();

  await passwordInput.waitFor({ timeout: 30000 });
  console.log('Passwort-Maske sichtbar → fülle Passwort.');

  await passwordInput.fill(DOCTOLIB_PASS);

  const passwordForm = passwordInput.locator('xpath=ancestor::form[1]');
  const passwordSubmit = passwordForm
    .locator(
      'button[type="submit"], button:has-text("Einloggen"), button:has-text("Login")'
    )
    .first();

  await Promise.all([
    passwordSubmit.click(),
    page.waitForNavigation({ waitUntil: 'networkidle' }),
  ]);

  console.log('Login abgeschlossen, aktuelle URL:', page.url());
}

// ---------- Statistik-Flow ----------

async function openStats(page, start, end) {
  const url = `https://pro.doctolib.de/configuration/statistics/queries?organization_id=${DOCTOLIB_ORG_ID}`;
  console.log('Öffne Statistik-Seite …', url);
  await page.goto(url, { waitUntil: 'networkidle' });

  console.log(`Setze Zeitraum: ${start} – ${end}`);
  await page.fill('#from', start);
  await page.fill('#to', end);
  await page.waitForTimeout(1000);
}

async function configureStats(page) {
  console.log('Konfiguriere Statistik …');

  await page.selectOption('#table', 'appointment'); // Termine
  await page.selectOption('#date_filtering', DATE_FILTERING);
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
    excludeSet.size ? Array.from(excludeSet).join(', ') : '(keine)'
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

async function exportStats(page, start, end) {
  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }

  console.log('Starte CSV-Export …');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('input[name="csv"]'), // Button „Exportieren“
  ]);

  const suggested = await download.suggestedFilename();
  const fileName = `doctolib_${start}_${end}_${suggested}`;
  const filePath = path.join(EXPORT_DIR, fileName);

  await download.saveAs(filePath);
  console.log('Export gespeichert unter:', filePath);
}

// ---------- Main ----------

(async () => {
  const { start, end } = lastMonthRange();
  console.log(`Zeitraum (letzter Monat): ${start} – ${end}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: DOCTOLIB_UA,
    viewport: { width: 1280, height: 720 },
    locale: 'de-DE',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  try {
    await login(page);
    await openStats(page, start, end);
    await configureStats(page);
    await exportStats(page, start, end);
    console.log('Doctolib-Export erfolgreich abgeschlossen.');
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
