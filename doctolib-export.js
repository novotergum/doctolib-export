// doctolib-export.js
// Automatischer CSV-Export aus Doctolib-Statistiken per Playwright

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// ----------------------------------------------------
// Konfiguration & Utility-Funktionen
// ----------------------------------------------------

const EXPORT_DIR = path.join(process.cwd(), 'exports');

/**
 * Datum im Format YYYY-MM-DD (UTC) formatieren – passend für <input type="date">
 */
function formatDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Letzten vollen Monat berechnen
 */
function computeLastFullMonthRange() {
  const now = new Date();
  const firstOfCurrentMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const lastDayPrevMonth = new Date(firstOfCurrentMonth.getTime() - 24 * 60 * 60 * 1000);
  const firstDayPrevMonth = new Date(
    Date.UTC(lastDayPrevMonth.getUTCFullYear(), lastDayPrevMonth.getUTCMonth(), 1)
  );

  return {
    from: formatDate(firstDayPrevMonth),
    to: formatDate(lastDayPrevMonth),
  };
}

/**
 * Env-Variablen einlesen, Fallback: letzter voller Monat
 */
function loadConfigFromEnv() {
  const email = process.env.DOCTOLIB_EMAIL;
  const password = process.env.DOCTOLIB_PASSWORD;
  const orgId = process.env.DOCTOLIB_ORG_ID; // aktuell noch ungenutzt, aber vorgesehen
  const storageStatePath = process.env.DOCTOLIB_STORAGE_STATE || null;

  if (!storageStatePath && (!email || !password || !orgId)) {
    console.error(
      'Bitte mindestens DOCTOLIB_STORAGE_STATE ODER (DOCTOLIB_EMAIL, DOCTOLIB_PASSWORD, DOCTOLIB_ORG_ID) setzen.'
    );
    process.exit(1);
  }

  let from = process.env.DOCTOLIB_FROM;
  let to = process.env.DOCTOLIB_TO;

  if (!from || !to) {
    const range = computeLastFullMonthRange();
    from = range.from;
    to = range.to;
    console.log(`DOCTOLIB_FROM/TO nicht gesetzt – nutze letzten vollen Monat: ${from} – ${to}`);
  }

  return { email, password, orgId, from, to, storageStatePath };
}

async function ensureExportDir() {
  await fs.promises.mkdir(EXPORT_DIR, { recursive: true });
}

// ----------------------------------------------------
// Cookie-/Consent-Banner Handling (Didomi & Co.)
// ----------------------------------------------------

async function maybeHandleCookieBanner(page) {
  // 1) Didomi-Overlay (#didomi-host)
  try {
    const didomiHost = page.locator('#didomi-host');
    if (await didomiHost.isVisible().catch(() => false)) {
      const acceptButton = didomiHost
        .locator(
          [
            'button:has-text("Alle akzeptieren")',
            'button:has-text("Akzeptieren")',
            'button:has-text("Zustimmen")',
            'button:has-text("Einverstanden")',
            'button:has-text("Accept all")',
            'button:has-text("Accept")',
          ].join(', ')
        )
        .first();

      if (await acceptButton.isVisible().catch(() => false)) {
        console.log('Didomi-Cookie-Overlay (#didomi-host) gefunden → klicke „Akzeptieren/Alle akzeptieren“.');
        await acceptButton.click({ trial: false });
        await page.waitForTimeout(1000);

        if (!(await didomiHost.isVisible().catch(() => false))) {
          return;
        }
      }
    }
  } catch (e) {
    // ignorieren
  }

  // 2) iframe-Variante
  try {
    const frameLocator = page.frameLocator(
      'iframe[id^="didomi-host"], iframe[src*="didomi"], iframe[title*="consent"], iframe[title*="Cookie"]'
    );
    const frameButton = frameLocator
      .locator(
        [
          'button:has-text("Alle akzeptieren")',
          'button:has-text("Akzeptieren")',
          'button:has-text("Zustimmen")',
          'button:has-text("Einverstanden")',
          'button:has-text("Accept all")',
          'button:has-text("Accept")',
        ].join(', ')
      )
      .first();

    if (await frameButton.isVisible().catch(() => false)) {
      console.log('Cookie-Banner im iframe gefunden → klicke „Akzeptieren/Alle akzeptieren“.');
      await frameButton.click();
      await page.waitForTimeout(1000);
      return;
    }
  } catch (e) {
    // ignorieren
  }

  // 3) restriktiver Fallback
  try {
    const didomiHost = page.locator('#didomi-host');
    const didomiVisible = await didomiHost.isVisible().catch(() => false);

    if (!didomiVisible) {
      const bannerButton = page
        .locator(
          [
            '#didomi-host button:has-text("Alle akzeptieren")',
            '#didomi-host button:has-text("Akzeptieren")',
            'button[data-testid*="accept"]:has-text("Akzeptieren")',
            'button[data-testid*="accept"]:has-text("Alle akzeptieren")',
          ].join(', ')
        )
        .first();

      if (await bannerButton.isVisible().catch(() => false)) {
        console.log('Cookie-Banner auf Hauptseite gefunden → klicke „Akzeptieren“.');
        await bannerButton.click();
        await page.waitForTimeout(1000);
        return;
      }
    }
  } catch (e) {
    // ignorieren
  }
}

// ----------------------------------------------------
// Login-Logik (nur als Fallback – bei dir triggert 2FA → bricht sauber ab)
// ----------------------------------------------------

async function login(page, email, password) {
  const loginUrl = 'https://pro.doctolib.de/signin';
  console.log(`Gehe zur Login-Seite – ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'networkidle' });

  await maybeHandleCookieBanner(page);

  const maxSteps = 10;

  for (let step = 1; step <= maxSteps; step++) {
    const currentUrl = page.url();
    console.log(`Login-Loop Step ${step}, aktuelle URL: ${currentUrl}`);

    if (!currentUrl.includes('/signin')) {
      console.log('Login scheint erfolgreich – nicht mehr auf /signin.');
      return;
    }

    if (currentUrl.includes('/signin/two-factor')) {
      throw new Error(
        'Doctolib verlangt Zwei-Faktor-Authentifizierung (/signin/two-factor). Automatischer Login wird abgebrochen.'
      );
    }

    await maybeHandleCookieBanner(page);

    const emailInput = page.locator('input[autocomplete="username"][type="email"]');
    const passwordInput = page.locator('input[autocomplete="current-password"][type="password"]');

    const emailVisible = await emailInput.isVisible().catch(() => false);
    const passwordVisible = await passwordInput.isVisible().catch(() => false);

    if (emailVisible && !passwordVisible) {
      const emailDisabled = !(await emailInput.isEnabled().catch(() => true));

      if (!emailDisabled) {
        console.log('E-Mail-Maske sichtbar (aktiv) → fülle E-Mail & klicke „Weiter“.');
        await emailInput.fill(email);
      } else {
        console.log(
          'E-Mail-Feld ist sichtbar, aber deaktiviert (vorbefüllt) → überspringe Fill & klicke nur „Weiter“.'
        );
      }

      await maybeHandleCookieBanner(page);

      const weiterButton = page.getByRole('button', { name: 'Weiter' }).first();

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
        weiterButton.click().catch((err) => {
          console.warn('Konnte „Weiter“-Button nicht klicken:', err.message);
        }),
      ]);

      await page.waitForTimeout(1500);
      continue;
    }

    if (passwordVisible) {
      console.log('Passwort-Maske sichtbar → fülle Passwort & bestätige über Enter.');

      await passwordInput.fill(password);
      await page.waitForTimeout(200);
      await maybeHandleCookieBanner(page);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
        passwordInput.press('Enter').catch(() => {}),
      ]);
      await page.waitForTimeout(2000);

      if (!page.url().includes('/signin')) {
        console.log('Login erfolgreich – nach Passwort-Eingabe weitergeleitet.');
        return;
      }

      const hasErrorText =
        (await page
          .getByText(/falsches Passwort|stimmen nicht überein|Ungültig|nicht korrekt/i)
          .first()
          .isVisible()
          .catch(() => false)) ||
        (await page
          .locator('.dl-text-error-090, .dl-input-validation-error')
          .first()
          .isVisible()
          .catch(() => false));

      if (hasErrorText) {
        throw new Error(
          'Doctolib zeigt weiterhin die Passwort-Maske mit Fehlermeldung – vermutlich falsches Passwort oder zusätzliche Sicherheitsprüfung. Bitte Zugangsdaten manuell im Browser testen.'
        );
      }

      console.log(
        'Passwort-Maske weiterhin sichtbar ohne klare Fehlermeldung – noch einen Versuch nach kurzem Warten …'
      );
      await page.waitForTimeout(1500);
      continue;
    }

    console.log(
      'Keine bekannte Login-Maske erkannt – versuche nochmals Cookie-/Consent-Overlay zu schließen & warte kurz …'
    );
    await maybeHandleCookieBanner(page);
    await page.waitForTimeout(1500);
  }

  throw new Error(`Login konnte nach ${maxSteps} Versuchen nicht abgeschlossen werden; aktuelle URL: ${page.url()}`);
}

// ----------------------------------------------------
// Statistik-Export
// ----------------------------------------------------

async function exportAppointmentStatistics(page, { from, to }) {
  const statsUrl = 'https://pro.doctolib.de/configuration/statistics';
  console.log(`Öffne Statistik-Seite – ${statsUrl}`);

  await page.goto(statsUrl, { waitUntil: 'networkidle' });
  await maybeHandleCookieBanner(page);

  const tableSelect = page.locator('#table');
  if (await tableSelect.isVisible().catch(() => false)) {
    await tableSelect.selectOption('appointment');
  }

  const dateFilteringSelect = page.locator('#date_filtering');
  if (await dateFilteringSelect.isVisible().catch(() => false)) {
    await dateFilteringSelect.selectOption('start_date');
  }

  const fromInput = page.locator('#from');
  const toInput = page.locator('#to');

  if (await fromInput.isVisible().catch(() => false)) {
    await fromInput.fill(from);
  }
  if (await toInput.isVisible().catch(() => false)) {
    await toInput.fill(to);
  }

  const groupSelect = page.locator('#appointment_group');
  if (await groupSelect.isVisible().catch(() => false)) {
    await groupSelect.selectOption('agenda');
  }

  const secondGroupSelect = page.locator('#appointment_second_group');
  if (await secondGroupSelect.isVisible().catch(() => false)) {
    await secondGroupSelect.selectOption('');
  }

  const exportButton = page.locator('input[type="submit"][name="csv"]');

  if (!(await exportButton.isVisible().catch(() => false))) {
    throw new Error('CSV-Export-Button (name="csv") wurde auf der Statistik-Seite nicht gefunden.');
  }

  console.log('Starte CSV-Export …');
  await ensureExportDir();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportButton.click().catch((err) => {
      console.error('Fehler beim Klick auf den CSV-Export-Button:', err.message);
      throw err;
    }),
  ]);

  const suggestedName = download.suggestedFilename();
  const fileName = suggestedName || `doctolib_appointments_${from}_${to}.csv`.replace(/:/g, '-');
  const targetPath = path.join(EXPORT_DIR, fileName);

  await download.saveAs(targetPath);
  console.log(`CSV erfolgreich gespeichert unter: ${targetPath}`);
}

// ----------------------------------------------------
// Main
// ----------------------------------------------------

(async () => {
  const { email, password, orgId, from, to, storageStatePath } = loadConfigFromEnv();
  void orgId; // derzeit ungenutzt

  const browser = await chromium.launch({ headless: true });

  let context;
  let page;

  try {
    await ensureExportDir();

    if (storageStatePath && fs.existsSync(storageStatePath)) {
      console.log(`Nutze vorhandenes storageState: ${storageStatePath} (kein Login via Passwort notwendig).`);
      context = await browser.newContext({ storageState: storageStatePath });
      page = await context.newPage();
    } else {
      console.log('Kein gültiges storageState gefunden – nutze Login via E-Mail/Passwort (falls kein 2FA).');
      context = await browser.newContext();
      page = await context.newPage();
      await login(page, email, password);
    }

    await exportAppointmentStatistics(page, { from, to });
    console.log('Doctolib-Export erfolgreich abgeschlossen.');
  } catch (err) {
    console.error('Fehler im Doctolib-Export:', err && err.message ? err.message : err);

    try {
      await ensureExportDir();
      const screenshotPath = path.join(EXPORT_DIR, 'error-login.png');
      if (!page && context) page = await context.newPage();
      if (page) {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error(`Fehler-Screenshot gespeichert unter: ${screenshotPath}`);
      }
    } catch (screenshotErr) {
      console.error('Konnte Fehler-Screenshot nicht speichern:', screenshotErr && screenshotErr.message);
    }

    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
