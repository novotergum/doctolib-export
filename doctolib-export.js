// doctolib-export.js
// Automatischer Doctolib-Statistik-Export (Termine) via Playwright/Chromium

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Pflicht-Umgebungsvariablen
const DOCTOLIB_USER = process.env.DOCTOLIB_USER;
const DOCTOLIB_PASS = process.env.DOCTOLIB_PASS;
const DOCTOLIB_ORG_ID = process.env.DOCTOLIB_ORG_ID; // z.B. 263702

// Export-Verzeichnis
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, 'exports');

// Statistik-Konfiguration (optional per ENV überschreibbar)
const DATE_FILTERING = process.env.DATE_FILTERING || 'start_date'; // 'start_date' = wahrgenommen, 'created_at' = gebucht
const PRIMARY_GROUP = process.env.PRIMARY_GROUP || 'agenda';       // 'agenda' = Terminkalender
const SECONDARY_GROUP = process.env.SECONDARY_GROUP || '';         // '' = keine zweite Gruppierung
const EXCLUDE_STATUSES = (process.env.EXCLUDE_STATUSES || 'deleted')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Sicherheitscheck ENV
if (!DOCTOLIB_USER || !DOCTOLIB_PASS || !DOCTOLIB_ORG_ID) {
  console.error('Fehlende ENV: DOCTOLIB_USER, DOCTOLIB_PASS und DOCTOLIB_ORG_ID müssen gesetzt sein.');
  process.exit(1);
}

// Zeitraum: letzter vollständiger Monat (Start/Ende im Format JJJJ-MM-TT)
function lastMonthRange() {
  const now = new Date();
  const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastLastMonth = new Date(firstThisMonth.getTime() - 1);
  const firstLastMonth = new Date(lastLastMonth.getFullYear(), lastLastMonth.getMonth(), 1);
  const fmt = d => d.toISOString().slice(0, 10); // YYYY-MM-DD
  return { start: fmt(firstLastMonth), end: fmt(lastLastMonth) };
}

// Login auf pro.doctolib.de – nutzt die echten Input-Felder (autocomplete="username"/"current-password")
async function login(page) {
  console.log('Gehe zur Login-Seite …');
  await page.goto('https://pro.doctolib.de/login', { waitUntil: 'networkidle' });

  page.setDefaultTimeout(60000);

  // Cookie-/Consent-Banner best-effort schließen
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
    // kein Banner sichtbar – ignorieren
  }

  // E-Mail / Username
  const emailLocator = page
    .locator('input[autocomplete="username"], input[type="email"]')
    .first();

  console.log('Warte auf E-Mail-Feld …');
  await emailLocator.waitFor();
  await emailLocator.fill(DOCTOLIB_USER);

  // Passwort
  const passwordLocator = page
    .locator('input[autocomplete="current-password"], input[type="password"]')
    .first();

  console.log('Warte auf Passwort-Feld …');
  await passwordLocator.waitFor();
  await passwordLocator.fill(DOCTOLIB_PASS);

  // Submit-Button
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

// Statistik-Seite öffnen und
