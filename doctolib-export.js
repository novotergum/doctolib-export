// doctolib-export.js
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL = process.env.DOCTOLIB_EMAIL;
const PASSWORD = process.env.DOCTOLIB_PASSWORD;
const ORG_ID = process.env.DOCTOLIB_ORG_ID;           // z.B. 263702
const FROM = process.env.DOCTOLIB_FROM;              // "2025-10-01"
const TO = process.env.DOCTOLIB_TO;                  // "2025-10-31"

const LOGIN_URL = 'https://pro.doctolib.de/signin';
const STATS_URL =
  `https://pro.doctolib.de/configuration/statistics/queries?organization_id=${ORG_ID}`;

async function acceptCookiesIfPresent(page) {
  const cookieButton = page.locator('button:has-text("Akzeptieren")');
  if (await cookieButton.count()) {
    console.log('Cookie- / Consent-Button gefunden → klicke …');
    await cookieButton.first().click({ timeout: 5000 }).catch(() => {});
  }
}

/**
 * Führt den kompletten Login durch, inkl. optionaler zweiter Passwort-Seite (/signin/two-factor).
 */
async function loginWithOptionalTwoFactor(page) {
  console.log('Gehe zur Login-Seite –', LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

  await acceptCookiesIfPresent(page);

  for (let step = 0; step < 4; step++) {
    const url = page.url();
    console.log('Login-Step', step, 'URL:', url);

    // 1. E-Mail-Eingabe falls sichtbar
    const emailInput = page.locator('input[autocomplete="username"], input[type="email"]');
    if (await emailInput.count() && await emailInput.first().isVisible()) {
    console.log("E-Mail-Maske sichtbar → fülle E-Mail.");
    await page.fill('input[autocomplete="username"], input[type="email"]', DOCTOLIB_EMAIL);
    
    // Neuer, eindeutiger Locator:
    const weiterButton = page.locator('button', { hasText: 'Weiter' }).first();
    await weiterButton.click();
    
    // Kurz warten, bis die nächste Seite/der nächste Step geladen ist
    await page.waitForLoadState('networkidle');
      ]);

      continue; // nächster Durchlauf → Passwortseite
    }

    // 2. Passwort-Eingabe (normaler Login oder /signin/two-factor)
    const passwordInput = page.locator('input[name="password"], input[autocomplete="current-password"]');
    if (await passwordInput.count() && await passwordInput.first().isVisible()) {
      console.log('Passwort-Maske sichtbar → fülle Passwort.');
      await passwordInput.first().fill(PASSWORD);

      const einloggenButton = page.locator('button span:text("Einloggen")').first().or(
        page.locator('button:has-text("Einloggen")').first()
      );

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        einloggenButton.click()
      ]);

      // Wenn wir nach dem ersten Login auf /signin/two-factor landen,
      // wird im nächsten Loop-Durchlauf wieder die Passwort-Maske erkannt.
      continue;
    }

    // 3. Prüfen, ob wir raus aus /signin sind → dann ist Login fertig
    if (!page.url().includes('/signin')) {
      console.log('Login abgeschlossen, aktuelle URL:', page.url());
      return;
    }

    // 4. Kleine Pause und nochmal versuchen
    await page.waitForTimeout(1000);
  }

  throw new Error(`Login konnte nicht abgeschlossen werden, aktuelle URL: ${page.url()}`);
}

async function openStatsAndExport(page, from, to) {
  console.log('Offline Statistik-Seite:', STATS_URL);
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

  // Sicherheit: Kontrollausgabe
  console.log('Zeitraum-Felder gesetzt, starte Export …');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('input[type="submit"][value*="Exportieren"]').click()
  ]);

  const suggested = download.suggestedFilename();
  const outDir = path.resolve('exports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, suggested);

  await download.saveAs(outPath);
  console.log('Export gespeichert unter:', outPath);
}

(async () => {
  if (!EMAIL || !PASSWORD || !ORG_ID || !FROM || !TO) {
    console.error('Bitte DOCTOLIB_EMAIL, DOCTOLIB_PASSWORD, DOCTOLIB_ORG_ID, DOCTOLIB_FROM und DOCTOLIB_TO setzen.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await loginWithOptionalTwoFactor(page);
    await openStatsAndExport(page, FROM, TO);
  } catch (err) {
    console.error('Fehler im Doctolib-Export:', err.message);
    console.error('Aktuelle URL:', page.url());
    // kleine HTML-Schnipsel loggen hilft beim Debugging
    const html = await page.content();
    console.error('HTML-Ausschnitt:', html.slice(0, 1000));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
