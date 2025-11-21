// doctolib-export.js
// Automatischer Doctolib-Statistik-Export (Termine) via Playwright/Chromium

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---------- ENV & Konstanten ----------

const EMAIL = process.env.DOCTOLIB_EMAIL;
const PASSWORD = process.env.DOCTOLIB_PASSWORD;
const ORG_ID = process.env.DOCTOLIB_ORG_ID; // z.B. 263702
let FROM = process.env.DOCTOLIB_FROM;       // "2025-10-01"
let TO = process.env.DOCTOLIB_TO;           // "2025-10-31"

const LOGIN_URL = process.env.DOCTOLIB_LOGIN_URL || 'https://pro.doctolib.de/signin';
const STATS_URL = `https://pro.doctolib.de/configuration/statistics/queries?organization_id=${ORG_ID}`;
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, 'exports');

const USER_AGENT =
  process.env.DOCTOLIB_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Fallback: wenn FROM/TO nicht gesetzt → letzter kompletter Monat
function getLastMonthRange() {
  const now = new Date();
  const firstThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastDayLastMonth = new Date(firstThisMonth.getTime() - 1);
  const firstDayLastMonth = new Date(
    Date.UTC(lastDayLastMonth.getUTCFullYear(), lastDayLastMonth.getUTCMonth(), 1)
  );

  const fmt = (d) => d.toISOString().slice(0, 10);
  return {
    from: fmt(firstDayLastMonth),
    to: fmt(lastDayLastMonth),
  };
}

if (!FROM || !TO) {
  const range = getLastMonthRange();
  FROM = range.from;
  TO = range.to;
  console.log('DOCTOLIB_FROM/TO nicht gesetzt – nutze letzten Monat:', FROM, '-', TO);
}

if (!EMAIL || !PASSWORD || !ORG_ID) {
  console.error(
    'Bitte DOCTOLIB_EMAIL, DOCTOLIB_PASSWORD und DOCTOLIB_ORG_ID setzen (ENV).'
  );
  process.exit(1);
}

// ---------- Hilfsfunktionen ----------

async function acceptCookiesIfPresent(page) {
  try {
    const btn = page
      .getByRole('button', { name: /akzeptieren|zustimmen|alle akzeptieren/i })
      .first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Cookie-/Consent-Button gefunden → klicke …');
      await btn.click();
      await page.waitForTimeout(1000);
    }
  } catch {
    // kein Banner, kein Problem
  }
}

/**
 * Führt den kompletten Login durch, inkl. optionaler zweiter Passwort-Seite (/signin/two-factor).
 */
async function loginWithOptionalTwoFactor(page) {
  console.log('Gehe zur Login-Seite –', LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  page.setDefaultTimeout(60000);

  await acceptCookiesIfPresent(page);

  // maximal 5 Iterationen: E-Mail → Passwort → ggf. zweites Passwort → fertig
  for (let step = 0; step < 5; step++) {
    const url = page.url();
    console.log('Login-Step', step, 'URL:', url);

    // ---------- 1) E-Mail-Maske ("Loggen Sie sich ein" + Feld "E-Mail-Adresse") ----------
    const emailField = page.getByLabel('E-Mail-Adresse').first();
    if (await emailField.isVisible().catch(() => false)) {
      console.log('E-Mail-Maske sichtbar → fülle E-Mail.');
      await emailField.fill(EMAIL);

      const weiterButton = page.locator('button', { hasText: 'Weiter' }).first();

      await Promise.all([
        weiterButton.click(),
        page
          .waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 })
          .catch(() => page.waitForLoadState('networkidle').catch(() => {})),
      ]);

      // danach kommt entweder direkt die Passwort-Maske oder dein Konto-Choice-Screen
      continue;
    }

    // ---------- 2) Passwort-Maske (auch /signin/two-factor) ----------
    // Markup:
    // <label ...>Passwort</label>
    // <input ... autocomplete="current-password" id="input_:r1:" type="password">
    const passwordField = page.getByLabel('Passwort').first();

    if (await passwordField.isVisible().catch(() => false)) {
      console.log('Passwort-Maske sichtbar → fülle Passwort.');
      await passwordField.fill(PASSWORD);

      const einloggenButton = page
        .locator('button', { hasText: 'Einloggen' })
        .first();

      await Promise.all([
        einloggenButton.click(),
        page
          .waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 })
          .catch(() => page.waitForLoadState('networkidle').catch(() => {})),
      ]);

      // Falls Doctolib danach noch einmal auf /signin/two-factor o.Ä. geht,
      // greifen wir im nächsten Loop-Durchlauf wieder auf das Passwort-Feld.
      if (!page.url().includes('/signin')) {
        console.log('Login abgeschlossen, aktuelle URL:', page.url());
        return;
      }

      continue;
    }

    // ---------- 3) Wenn wir nicht mehr auf /signin sind, sind wir drin ----------
    if (!page.url().includes('/signin')) {
      console.log('Login abgeschlossen, aktuelle URL:', page.url());
      return;
    }

    // ---------- 4) kleinen Moment warten und noch einmal prüfen ----------
    await page.waitForTimeout(1000);
  }

  throw new Error(`Login konnte nicht abgeschlossen werden, aktuelle URL: ${page.url()}`);
}

/**
 * Öffnet die Statistikseite und triggert den CSV-Export.
 */
async function openStatsAndExport(page, from, to) {
  console.log('Öffne Statistik-Seite:', STATS_URL);
  await page.goto(STATS_URL, { waitUntil: 'networkidle' });

  if (page.url().includes('/signin')) {
    throw new Error(
      'Nach dem Login wurde die Statistikseite erneut auf /signin umgeleitet (vermutlich Login/2FA fehlgeschlagen).'
    );
  }

  console.log('Setze Zeitraum:', from, '–', to);

  const fromInput = page.locator('#from');
  const toInput = page.locator('#to');

  await fromInput.waitFor({ timeout: 20000 });

  await fromInput.fill(from);
  await toInput.fill(to);

  // Optional: ein wenig warten, bis Doctolib intern neu berechnet
  await page.waitForTimeout(1000);

  console.log('Zeitraum gesetzt, starte Export …');

  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('input[type="submit"][value*="Exportieren"]').click(),
  ]);

  const suggested = await download.suggestedFilename();
  const outPath = path.join(EXPORT_DIR, suggested);

  await download.saveAs(outPath);
  console.log('Export gespeichert unter:', outPath);
}

// ---------- Main ----------

(async () => {
  console.log(`Starte Doctolib-Export für Zeitraum: ${FROM} – ${TO}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 720 },
    locale: 'de-DE',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  try {
    await loginWithOptionalTwoFactor(page);
    await openStatsAndExport(page, FROM, TO);
    console.log('Doctolib-Export erfolgreich abgeschlossen.');
  } catch (err) {
    console.error('Fehler im Doctolib-Export:', err && err.message ? err.message : err);
    console.error('Aktuelle URL:', page.url());

    try {
      if (!fs.existsSync(EXPORT_DIR)) {
        fs.mkdirSync(EXPORT_DIR, { recursive: true });
      }
      const screenshotPath = path.join(EXPORT_DIR, 'error-login.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log('Fehler-Screenshot gespeichert unter:', screenshotPath);

      const html = await page.content();
      console.log('HTML-Ausschnitt:\n', html.slice(0, 2000));
    } catch (screenshotErr) {
      console.error('Konnte Screenshot/HTML nicht speichern:', screenshotErr);
    }

    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
