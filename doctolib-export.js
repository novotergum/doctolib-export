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
 * Letzten vollen Monat berechnen (z. B. heute 2025-11-21 → 2025-10-01 bis 2025-10-31)
 */
function computeLastFullMonthRange() {
  const now = new Date();
  const firstOfCurrentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastDayPrevMonth = new Date(firstOfCurrentMonth.getTime() - 24 * 60 * 60 * 1000);
  const firstDayPrevMonth = new Date(Date.UTC(lastDayPrevMonth.getUTCFullYear(), lastDayPrevMonth.getUTCMonth(), 1));

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
  const orgId = process.env.DOCTOLIB_ORG_ID; // aktuell optional, für spätere DB-Insights-Nutzung

  if (!email || !password || !orgId) {
    console.error('Bitte DOCTOLIB_EMAIL, DOCTOLIB_PASSWORD und DOCTOLIB_ORG_ID als Umgebungsvariablen setzen.');
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

  return { email, password, orgId, from, to };
}

/**
 * Stellt sicher, dass der Export-Ordner existiert.
 */
async function ensureExportDir() {
  await fs.promises.mkdir(EXPORT_DIR, { recursive: true });
}

// ----------------------------------------------------
// Cookie-Banner / Consent
// ----------------------------------------------------

/**
 * Versucht, Cookie-/Consent-Banner zu schließen (Hauptseite + iframe-Varianten).
 * Keine harte Abhängigkeit – wenn nichts gefunden wird, läuft es einfach weiter.
 */
async function maybeHandleCookieBanner(page) {
  // Variante: Banner direkt auf der Seite als Button
  try {
    const bannerButton = page
      .getByRole('button', {
        name: /Akzeptieren|Alle akzeptieren|Einverstanden|Zustimmen|OK|Okay|Alles erlauben|Ich stimme zu/i,
      })
      .first();

    if (await bannerButton.isVisible().catch(() => false)) {
      console.log('Cookie-Banner auf Hauptseite gefunden → klicke „Akzeptieren“.');
      await bannerButton.click();
      await page.waitForTimeout(1000);
      return;
    }
  } catch {
    // Ignorieren, wenn nichts gefunden wird
  }

  // Variante: Cookie-Banner in iframe (z. B. Didomi)
  try {
    const frameLocator = page.frameLocator(
      'iframe[id^="didomi-host"], iframe[src*="didomi"], iframe[title*="consent"], iframe[title*="Cookie"]'
    );
    const frameButton = frameLocator
      .getByRole('button', {
        name: /Akzeptieren|Alle akzeptieren|Einverstanden|Zustimmen|OK|Okay|Agree|Accept/i,
      })
      .first();

    if (await frameButton.isVisible().catch(() => false)) {
      console.log('Cookie-Banner im iframe gefunden → klicke „Akzeptieren“.');
      await frameButton.click();
      await page.waitForTimeout(1000);
    }
  } catch {
    // Ebenfalls ignorieren
  }
}

// ----------------------------------------------------
// Login-Logik (mehrstufig, robust gegen UI-Varianten)
// ----------------------------------------------------

/**
 * Login bei Doctolib.
 * Unterstützt:
 *  - klassischen 2-Screen Login (E-Mail → Passwort)
 *  - re-auth Screen „Passwort eingeben“ (wenn man schon eingeloggt war)
 *
 * Bricht ab, wenn Doctolib eine echte Zwei-Faktor-Seite (/signin/two-factor) anzeigt.
 */
async function login(page, email, password) {
  const loginUrl = 'https://pro.doctolib.de/signin';
  console.log(`Gehe zur Login-Seite – ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'networkidle' });

  await maybeHandleCookieBanner(page);

  const maxSteps = 10;

  for (let step = 1; step <= maxSteps; step++) {
    const currentUrl = page.url();
    console.log(`Login-Loop Step ${step}, aktuelle URL: ${currentUrl}`);

    // Wenn wir nicht mehr auf /signin sind → Login offenbar erfolgreich
    if (!currentUrl.includes('/signin')) {
      console.log('Login scheint erfolgreich – nicht mehr auf /signin.');
      return;
    }

    // Falls Doctolib auf Zwei-Faktor-Seite geleitet hat → sauber abbrechen
    if (currentUrl.includes('/signin/two-factor')) {
      throw new Error(
        'Doctolib verlangt Zwei-Faktor-Authentifizierung (/signin/two-factor). Automatischer Login wird abgebrochen.'
      );
    }

    // Selektoren passen exakt zu den von dir geposteten HTML-Snippets
    const emailInput = page.locator('input[autocomplete="username"][type="email"]');
    const passwordInput = page.locator('input[autocomplete="current-password"][type="password"]');

    const emailVisible = await emailInput.isVisible().catch(() => false);
    const passwordVisible = await passwordInput.isVisible().catch(() => false);

    // 1) E-Mail-Maske (Screen „Loggen Sie sich ein“)
    if (emailVisible && !passwordVisible) {
      const emailDisabled = !(await emailInput.isEnabled().catch(() => true));

      if (!emailDisabled) {
        console.log('E-Mail-Maske sichtbar (aktiv) → fülle E-Mail & klicke „Weiter“.');
        await emailInput.fill(email);
      } else {
        console.log('E-Mail-Feld ist sichtbar, aber deaktiviert (vorbefüllt) → klicke nur „Weiter“.');
      }

      const weiterButton = page.getByRole('button', { name: 'Weiter' }).first();

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
        weiterButton.click().catch((err) => {
          console.warn('Konnte „Weiter“-Button nicht klicken:', err.message);
        }),
      ]);

      await page.waitForTimeout(1500);
      await maybeHandleCookieBanner(page);
      continue;
    }

    // 2) Passwort-Maske (Screen „Passwort eingeben“ oder Re-Auth)
    if (passwordVisible) {
      console.log('Passwort-Maske sichtbar → fülle Passwort & bestätige über Enter.');

      await passwordInput.fill(password);
      await page.waitForTimeout(200);

      // Enter auf dem Passwortfeld löst den Form-Submit aus
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
        passwordInput.press('Enter').catch(() => {}),
      ]);
      await page.waitForTimeout(2000);

      // Prüfen, ob wir von /signin weg sind
      if (!page.url().includes('/signin')) {
        console.log('Login erfolgreich – nach Passwort-Eingabe weitergeleitet.');
        return;
      }

      // Noch auf /signin → schauen, ob eine Fehlermeldung angezeigt wird
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
        'Passwort-Maske weiterhin sichtbar ohne klare Fehlermeldung – Cookie-Banner prüfen & noch einen Versuch zulassen …'
      );
      await maybeHandleCookieBanner(page);
      await page.waitForTimeout(1500);
      continue;
    }

    // 3) Weder E-Mail- noch Passwort-Feld erkennbar
    console.log(
      'Keine bekannte Login-Maske erkannt – versuche ggf. Cookie-/Consent-Banner zu schließen & warte kurz, dann erneut prüfen …'
    );
    await maybeHandleCookieBanner(page);
    await page.waitForTimeout(1500);
  }

  throw new Error(`Login konnte nach ${maxSteps} Versuchen nicht abgeschlossen werden; aktuelle URL: ${page.url()}`);
}

// ----------------------------------------------------
// Statistik-Export
// ----------------------------------------------------

/**
 * Navigiert auf die Statistik-Seite und exportiert Termine als CSV.
 * - Tabelle: Termine
 * - Datumsfilter: wahrgenommene Termine (start_date)
 * - Gruppierung: Terminkalender (agenda)
 */
async function exportAppointmentStatistics(page, { from, to }) {
  const statsUrl = 'https://pro.doctolib.de/configuration/statistics';
  console.log(`Öffne Statistik-Seite – ${statsUrl}`);

  await page.goto(statsUrl, { waitUntil: 'networkidle' });
  await maybeHandleCookieBanner(page);

  // Tabelle „Termine“
  const tableSelect = page.locator('#table');
  if (await tableSelect.isVisible().catch(() => false)) {
    await tableSelect.selectOption('appointment');
  }

  // Datumsfilter: „wahrgenommenen“ Termine → start_date
  const dateFilteringSelect = page.locator('#date_filtering');
  if (await dateFilteringSelect.isVisible().catch(() => false)) {
    await dateFilteringSelect.selectOption('start_date'); // "wahrgenommenen Termine"
  }

  // Datumsbereich setzen
  const fromInput = page.locator('#from');
  const toInput = page.locator('#to');

  if (await fromInput.isVisible().catch(() => false)) {
    await fromInput.fill(from);
  }
  if (await toInput.isVisible().catch(() => false)) {
    await toInput.fill(to);
  }

  // Gruppierung: nach Terminkalender, optional ohne zweite Gruppierung
  const groupSelect = page.locator('#appointment_group');
  if (await groupSelect.isVisible().catch(() => false)) {
    await groupSelect.selectOption('agenda'); // Terminkalender = pro Standort-Kalender
  }

  const secondGroupSelect = page.locator('#appointment_second_group');
  if (await secondGroupSelect.isVisible().catch(() => false)) {
    await secondGroupSelect.selectOption(''); // Keine zweite Gruppierung
  }

  // Optional: Status-Filter anpassen – Beispiel: gelöschte Termine ausschließen
  // Hängt von deinem gewünschten Reporting ab; hier nur exemplarisch:
  /*
  const deletedCheckbox = page.locator('input[name="status_filters[]"][value="deleted"]');
  if (await deletedCheckbox.isChecked().catch(() => false)) {
    console.log('Schließe gelöschte Termine aus.');
    await deletedCheckbox.uncheck();
  }
  */

  // CSV-Export-Button klicken und Download abfangen
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
  const { email, password, orgId, from, to } = loadConfigFromEnv();
  // orgId aktuell nicht genutzt, aber für spätere DB-Insights-Exports bereits vorhanden
  void orgId;

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    // Optional: realistischere Viewport/User-Agent-Konfiguration
  });

  const page = await context.newPage();

  try {
    await ensureExportDir();

    await login(page, email, password);
    await exportAppointmentStatistics(page, { from, to });

    console.log('Doctolib-Export erfolgreich abgeschlossen.');
  } catch (err) {
    console.error('Fehler im Doctolib-Export:', err && err.message ? err.message : err);

    try {
      await ensureExportDir();
      const screenshotPath = path.join(EXPORT_DIR, 'error-login.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`Fehler-Screenshot gespeichert unter: ${screenshotPath}`);
    } catch (screenshotErr) {
      console.error('Konnte Fehler-Screenshot nicht speichern:', screenshotErr && screenshotErr.message);
    }

    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
