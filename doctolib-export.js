// doctolib-export.js
// Läuft als ES-Modul mit "type": "module" in package.json

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Hilfsfunktion für Pflicht-ENV-Variablen
 */
function getEnv(name, required = true) {
  const value = process.env[name];
  if (required && (!value || value.trim() === '')) {
    throw new Error(`Bitte ENV-Variable ${name} setzen.`);
  }
  return value;
}

/**
 * Fallback: letzter kompletter Monat (YYYY-MM-DD)
 */
function getDefaultPeriod() {
  const now = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstOfPrevMonth = new Date(
    now.getFullYear(),
    now.getMonth() - 1,
    1
  );
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 24 * 60 * 60 * 1000);

  const fmt = (d) => d.toISOString().slice(0, 10);

  return {
    from: fmt(firstOfPrevMonth),
    to: fmt(lastOfPrevMonth),
  };
}

/**
 * Cookie-Banner wegklicken (best effort)
 */
async function handleCookieBanner(page) {
  try {
    const btn = page.getByRole('button', { name: /akzeptieren/i });
    if (await btn.isVisible()) {
      console.log('Cookie-/Consent-Button gefunden → klicke …');
      await btn.click();
      await page.waitForTimeout(500);
    }
  } catch {
    // Banner einfach ignorieren, wenn nichts gefunden wird
  }
}

/**
 * Login-Flow:
 * 1. /signin → E-Mail + „Weiter“
 * 2. Passwort-Maske (kann /signin/password ODER /signin/two-factor sein) → Passwort + „Einloggen“
 * 3. Warten bis wir IRGENDEINE URL haben, die NICHT mehr /signin… ist
 */
async function login(page, email, password) {
  console.log('Gehe zur Login-Seite – https://pro.doctolib.de/signin');
  await page.goto('https://pro.doctolib.de/signin', {
    waitUntil: 'domcontentloaded',
  });
  console.log('Login-Step 0 URL:', page.url());

  await handleCookieBanner(page);

  // --- Step 1: E-Mail-Adresse ------------------------------
  const emailInput = page.locator(
    'input[autocomplete="username"][type="email"], input#input_:r0:'
  );
  await emailInput.waitFor({ timeout: 30000 });
  console.log('E-Mail-Maske sichtbar → fülle E-Mail.');
  await emailInput.fill(email);

  const nextButton = page.getByRole('button', { name: 'Weiter' });
  await nextButton.click();
  await page.waitForLoadState('networkidle');
  console.log('Login-Step 1 URL:', page.url());

  // --- Step 2: Passwort-Maske (Route kann /signin/two-factor heißen) ---
  const passwordInput = page.locator(
    'input[autocomplete="current-password"][type="password"], input#input_:r1:'
  );
  await passwordInput.waitFor({ timeout: 30000 });
  console.log('Passwort-Maske sichtbar → fülle Passwort.');
  await passwordInput.fill(password);

  const loginButton = page.getByRole('button', { name: 'Einloggen' });
  await loginButton.click();
  console.log('Login-Step 2 URL:', page.url());

  // --- Step 3: Warten bis wir NICHT mehr auf /signin… sind --------------
  try {
    await page.waitForURL(
      (url) => !/^\/signin(\/.*)?$/.test(new URL(url).pathname),
      { timeout: 60000 }
    );
    await page.waitForLoadState('networkidle');
    console.log('Login abgeschlossen, aktuelle URL:', page.url());
  } catch (err) {
    // Wenn wir nach 60s immer noch auf /signin… hängen, explizite Fehlermeldung
    throw new Error(
      `Login konnte nicht abgeschlossen werden; aktuelle URL: ${page.url()}`
    );
  }
}

/**
 * Statistik-Export für einen Zeitraum
 */
async function exportStatistics(page, orgId, fromDate, toDate) {
  const statsUrl = `https://pro.doctolib.de/configuration/statistics/queries?organization_id=${orgId}`;
  console.log('Offne Statistik-Seite –', statsUrl);
  await page.goto(statsUrl, { waitUntil: 'domcontentloaded' });

  console.log('Setze Zeitraum:', fromDate, '–', toDate);

  // Statistik zu: Termine
  await page.locator('select[name="table"]').selectOption('appointment');

  // Statistik der wahrgenommenen Termine
  await page.locator('select[name="date_filtering"]').selectOption('start_date');

  // Zeitraum
  const fromInput = page.locator('input[name="from"]');
  const toInput = page.locator('input[name="to"]');
  await fromInput.fill(fromDate);
  await toInput.fill(toDate);

  // Nach: Tag des Termins
  await page
    .locator('select[name="appointment_group"]')
    .selectOption('start_date_day');
  // dann nach: Keine
  await page
    .locator('select[name="appointment_second_group"]')
    .selectOption('');

  // Auswählen: Anzahl an Terminen
  await page
    .locator('select[name="appointment_select"]')
    .selectOption('appointment_count');

  // Optional: „Gelöscht“ ausschließen, falls angehakt
  const deletedCheckbox = page.locator(
    'input[name="status_filters[]"][value="deleted"]'
  );
  if (await deletedCheckbox.isChecked()) {
    await deletedCheckbox.uncheck();
  }

  // Download-Ordner vorbereiten
  const exportDir = path.join(__dirname, 'exports');
  fs.mkdirSync(exportDir, { recursive: true });
  const targetPath = path.join(
    exportDir,
    `doctolib_${fromDate}_${toDate}.csv`
  );

  console.log('Starte CSV-Export …');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.getByRole('button', { name: 'Exportieren' }).click(),
  ]);

  const suggested = download.suggestedFilename();
  console.log('Vorgeschlagener Dateiname:', suggested);

  await download.saveAs(targetPath);
  console.log('CSV gespeichert unter:', targetPath);
}

/**
 * Main
 */
async function main() {
  const email = getEnv('DOCTOLIB_EMAIL');
  const password = getEnv('DOCTOLIB_PASSWORD');
  const orgId = getEnv('DOCTOLIB_ORG_ID');

  let from = process.env.DOCTOLIB_FROM;
  let to = process.env.DOCTOLIB_TO;

  if (!from || !to) {
    const fallback = getDefaultPeriod();
    if (!from) from = fallback.from;
    if (!to) to = fallback.to;
    console.log(
      'DOCTOLIB_FROM/TO nicht gesetzt – nutze letzten vollen Monat:',
      from,
      '–',
      to
    );
  } else {
    console.log('Zeitraum (ENV):', from, '–', to);
  }

  const headless = process.env.HEADLESS !== 'false';

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'de-DE',
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    await login(page, email, password);
    await exportStatistics(page, orgId, from, to);
  } catch (err) {
    console.error('Fehler im Doctolib-Export:', err.message || err);

    try {
      const exportDir = path.join(__dirname, 'exports');
      fs.mkdirSync(exportDir, { recursive: true });
      const screenshotPath = path.join(exportDir, 'error-login.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error('Fehler-Screenshot gespeichert unter:', screenshotPath);
    } catch (sErr) {
      console.error('Konnte Fehler-Screenshot nicht schreiben:', sErr);
    }

    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Unerwarteter Fehler:', err);
  process.exit(1);
});
