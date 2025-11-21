// doctolib-export.js
// Läuft mit Node 20 + Playwright
// package.json sollte "type": "module" enthalten.

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- ENV & UTILITIES ----------

function getEnvVar(name, { required = true, defaultValue = undefined } = {}) {
  const value = process.env[name];
  if (required && (!value || value.trim() === '')) {
    throw new Error(`Bitte Umgebungsvariable ${name} setzen.`);
  }
  return value?.trim() ?? defaultValue;
}

function getDateRangeFromEnvOrLastFullMonth() {
  const fromEnv = (process.env.DOCTOLIB_FROM || '').trim();
  const toEnv = (process.env.DOCTOLIB_TO || '').trim();

  if (fromEnv && toEnv) {
    return { from: fromEnv, to: toEnv };
  }

  // Letzten vollen Monat berechnen (YYYY-MM-DD)
  const now = new Date();
  const firstOfCurrentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastOfPreviousMonth = new Date(firstOfCurrentMonth.getTime() - 1);
  const firstOfPreviousMonth = new Date(Date.UTC(lastOfPreviousMonth.getUTCFullYear(), lastOfPreviousMonth.getUTCMonth(), 1));

  const fmt = (d) =>
    d.toISOString().slice(0, 10); // YYYY-MM-DD

  const from = fmt(firstOfPreviousMonth);
  const to = fmt(lastOfPreviousMonth);

  console.log(`DOCTOLIB_FROM/TO nicht gesetzt – nutze letzten vollen Monat: ${from} – ${to}`);
  return { from, to };
}

function ensureExportsDir() {
  const exportsDir = path.join(__dirname, 'exports');
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }
  return exportsDir;
}

// ---------- LOGIN-LOGIK ----------

/**
 * Robuster Login:
 * - /signin E-Mail-Maske → E-Mail + "Weiter"
 * - /signin Passwort-Maske (neues Oxygen-UI) → Passwort + "Einloggen"
 * - Re-Auth-Maske (altes UI, input#password) → Passwort + "Einloggen"
 */
async function performLogin(page, email, password) {
  console.log('Gehe zur Login-Seite – https://pro.doctolib.de/signin');
  await page.goto('https://pro.doctolib.de/signin', { waitUntil: 'networkidle' });

  for (let step = 1; step <= 10; step++) {
    const url = page.url();
    console.log(`Login-Loop Step ${step}, aktuelle URL: ${url}`);

    // Wenn wir nicht mehr auf /signin sind → Login erfolgreich
    if (!url.includes('/signin')) {
      console.log('Login erfolgreich – wir sind nicht mehr auf /signin.');
      return;
    }

    // Sicherheitscheck: 2FA-/Two-Factor-Seite
    if (url.includes('/signin/two-factor')) {
      throw new Error(
        'Doctolib verlangt Zwei-Faktor-Authentifizierung / zusätzlichen Sicherheitscode. ' +
          'Automatischer Login ohne manuellen Eingriff ist so nicht möglich.'
      );
    }

    // --- FALL 3: Re-Auth-Formular (altes UI, bereits eingeloggt, input#password) ---
    const legacyPasswordInput = page.locator('input#password[name="password"]');
    if (await legacyPasswordInput.first().isVisible().catch(() => false)) {
      console.log('Re-Auth-Passwort-Formular sichtbar → fülle Passwort & klicke "Einloggen".');

      await legacyPasswordInput.fill(password);

      const loginButton = page.getByRole('button', { name: 'Einloggen' });
      await loginButton.click();
      await page.waitForTimeout(1500);
      continue;
    }

    // --- FALL 2: Neue Passwort-Seite mit Avatar ("Passwort eingeben") ---
    const passwordHeading = page.getByRole('heading', { name: /Passwort eingeben/i });
    if (await passwordHeading.first().isVisible().catch(() => false)) {
      console.log('Passwort-Maske (neues UI) sichtbar → fülle Passwort & klicke "Einloggen".');

      // Wichtig: nicht getByLabel('Passwort') benutzen (kollidiert mit IconButton „Passwort anzeigen“)
      const newPasswordInput = page
        .locator('input[autocomplete="current-password"][type="password"]')
        .first();

      await newPasswordInput.fill(password);

      const loginButton = page.getByRole('button', { name: 'Einloggen' });
      await loginButton.click();
      await page.waitForTimeout(1500);

      // Wenn nach einem Login-Versuch immer noch Passwort-Maske: evtl. falsches PW oder zusätzlicher Check
      const stillOnSignin = page.url().includes('/signin');
      const stillPasswordHeading = await passwordHeading.first().isVisible().catch(() => false);
      if (stillOnSignin && stillPasswordHeading) {
        console.log(
          'Hinweis: Nach Passwort-Submit ist weiterhin die Passwort-Maske sichtbar. ' +
            'Entweder ist das Passwort falsch oder es gibt eine zusätzliche Sicherheitsabfrage.'
        );
      }

      continue;
    }

    // --- FALL 1: E-Mail-Maske ---
    const emailInput = page
      .locator('input[autocomplete="username"][type="email"], input#input_:r0:')
      .first();

    if (await emailInput.isVisible().catch(() => false)) {
      const disabled = await emailInput.isDisabled().catch(() => false);

      if (!disabled) {
        console.log('E-Mail-Maske (aktiv) → fülle E-Mail & klicke "Weiter".');
        await emailInput.fill(email);
      } else {
        console.log('E-Mail-Feld ist deaktiviert (vorbefüllt) → klicke nur "Weiter".');
      }

      const weiterButton = page.getByRole('button', { name: 'Weiter' });
      await weiterButton.click();
      await page.waitForTimeout(1500);
      continue;
    }

    console.log('Keine bekannte Login-Maske erkannt – warte kurz & prüfe erneut …');
    await page.waitForTimeout(1000);
  }

  throw new Error(`Login konnte nicht abgeschlossen werden; aktuelle URL: ${page.url()}`);
}

// ---------- STATISTIK-EXPORT ----------

/**
 * Navigiert zur Statistik-Seite, setzt Datum & Organisation und triggert CSV-Export.
 *
 * Du kannst DOCTOLIB_STATS_URL überschreiben, wenn die URL anders ist.
 */
async function exportStatistics(page, { orgId, from, to }) {
  const statsUrlFromEnv = (process.env.DOCTOLIB_STATS_URL || '').trim();

  // Fallback-URL – ggf. im Account anpassen/überschreiben über DOCTOLIB_STATS_URL
  const defaultStatsUrl = `https://pro.doctolib.de/configuration/statistics?organization_id=${encodeURIComponent(
    orgId
  )}`;

  const targetUrl = statsUrlFromEnv || defaultStatsUrl;

  console.log(`Öffne Statistik-Seite: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle' });

  // Warten, bis das Statistik-Formular sichtbar ist
  const tableSelect = page.locator('select#table');
  await tableSelect.waitFor({ state: 'visible', timeout: 30000 });

  // "Termine" auswählen (falls nicht schon vorausgewählt)
  try {
    await tableSelect.selectOption('appointment');
  } catch {
    // Wenn die Option bereits gesetzt ist oder das Select anders funktioniert, einfach weitermachen.
  }

  // Datum setzen – die Inputs sind type="date" mit IDs #from und #to
  const fromInput = page.locator('input#from');
  const toInput = page.locator('input#to');

  await fromInput.waitFor({ state: 'visible', timeout: 15000 });
  await toInput.waitFor({ state: 'visible', timeout: 15000 });

  console.log(`Setze Zeitraum: von ${from} bis ${to}`);
  await fromInput.fill(from);
  await toInput.fill(to);

  // Sicherstellen, dass die Form übernommen ist (kurze Pause)
  await page.waitForTimeout(500);

  // Download-Ereignis abfangen
  const exportsDir = ensureExportsDir();
  const fileName = `doctolib_appointments_${orgId}_${from}_${to}.csv`;
  const targetPath = path.join(exportsDir, fileName);

  console.log('Starte CSV-Export (warte auf Download)…');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    // Entweder Button "Exportieren" (altes UI) oder input[name="csv"]
    (async () => {
      const exportButton = page.getByRole('button', { name: /Exportieren/i });
      if (await exportButton.isVisible().catch(() => false)) {
        await exportButton.click();
        return;
      }
      const exportInput = page.locator('input[type="submit"][name="csv"]');
      if (await exportInput.isVisible().catch(() => false)) {
        await exportInput.click();
        return;
      }
      throw new Error('Kein "Exportieren"-Button/Submit-Button gefunden.');
    })(),
  ]);

  const suggested = download.suggestedFilename();
  console.log(`Download gestartet, vorgeschlagener Dateiname: ${suggested}`);

  await download.saveAs(targetPath);
  console.log(`Export erfolgreich gespeichert unter: ${targetPath}`);
}

// ---------- MAIN ----------

async function main() {
  const email = getEnvVar('DOCTOLIB_EMAIL');
  const password = getEnvVar('DOCTOLIB_PASSWORD');
  const orgId = getEnvVar('DOCTOLIB_ORG_ID');
  const { from, to } = getDateRangeFromEnvOrLastFullMonth();

  const headless = process.env.HEADLESS === 'false' ? false : true;

  ensureExportsDir();

  const browser = await chromium.launch({
    headless,
  });

  const context = await browser.newContext({
    locale: 'de-DE',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    await performLogin(page, email, password);

    // Nach Login: ggf. Doctolib eigenständig auf eine Startseite umleiten lassen,
    // dann Statistik aufrufen.
    await exportStatistics(page, { orgId, from, to });

    await browser.close();
  } catch (err) {
    console.error('Fehler im Doctolib-Export:', err?.message || err);

    try {
      const exportsDir = ensureExportsDir();
      const screenshotPath = path.join(exportsDir, 'error-login.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`Fehler-Screenshot gespeichert unter: ${screenshotPath}`);
    } catch (sErr) {
      console.error('Screenshot konnte nicht erstellt werden:', sErr?.message || sErr);
    }

    await browser.close();
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Direkt aufgerufen
  main();
}
