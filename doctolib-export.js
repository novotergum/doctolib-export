// doctolib-export.js
// Läuft mit Node 20 + Playwright (ESM). In package.json idealerweise: "type": "module"

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------------------------------------------
// ENV-Handling
// -------------------------------------------------------------

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Bitte Umgebungsvariable ${name} setzen.`);
  }
  return value;
}

function getDateRangeFromEnv() {
  let from = process.env.DOCTOLIB_FROM;
  let to = process.env.DOCTOLIB_TO;

  if (!from || !to) {
    // letzten vollen Monat bestimmen
    const now = new Date();
    const firstOfCurrent = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastOfPrevious = new Date(firstOfCurrent.getTime() - 24 * 60 * 60 * 1000);
    const firstOfPrevious = new Date(
      lastOfPrevious.getFullYear(),
      lastOfPrevious.getMonth(),
      1
    );

    from = firstOfPrevious.toISOString().slice(0, 10);
    to = lastOfPrevious.toISOString().slice(0, 10);

    console.log(
      `DOCTOLIB_FROM/TO nicht gesetzt – nutze letzten vollen Monat: ${from} – ${to}`
    );
  } else {
    console.log(`Nutze Zeitraum aus ENV: ${from} – ${to}`);
  }

  return { from, to };
}

async function ensureExportsDir() {
  const exportsDir = path.join(__dirname, 'exports');
  await fs.promises.mkdir(exportsDir, { recursive: true });
  return exportsDir;
}

// -------------------------------------------------------------
// Login-Flow
// -------------------------------------------------------------

async function acceptCookiesIfVisible(page) {
  const candidates = [
    /alle akzeptieren/i,
    /akzeptieren/i,
    /zustimmen/i,
    /verstanden/i,
    /ich stimme zu/i,
  ];

  for (const text of candidates) {
    const btn = page.getByRole('button', { name: text });
    try {
      if (await btn.isVisible({ timeout: 2000 })) {
        console.log('Cookie-/Consent-Button gefunden → klicke …');
        await btn.click();
        await page.waitForTimeout(1000);
        return;
      }
    } catch {
      // ignorieren
    }
  }
}

/**
 * Login-Schleife:
 * - Solange wir auf /signin… sind:
 *   - wenn E-Mail-Feld sichtbar UND nicht disabled → E-Mail + "Weiter"
 *   - sonst, wenn Passwort-Feld sichtbar → Passwort + "Einloggen"
 *   - sonst kurz warten
 * - Sobald URL nicht mehr /signin… enthält → Login fertig
 */
async function login(page, email, password) {
  const loginUrl = 'https://pro.doctolib.de/signin';

  console.log('Gehe zur Login-Seite –', loginUrl);
  await page.goto(loginUrl, { waitUntil: 'networkidle' });
  console.log('Login-Step 0 URL:', page.url());

  await acceptCookiesIfVisible(page);

  // Wir erlauben bis zu 8 Iterationen (E-Mail → Passwort → ggf. zusätzliche Bestätigungen)
  for (let step = 1; step <= 8; step++) {
    const currentUrl = page.url();
    console.log(`Login-Loop Step ${step}, aktuelle URL: ${currentUrl}`);

    // Wenn wir nicht mehr auf /signin… sind, ist der Login fertig
    try {
      const u = new URL(currentUrl);
      if (!u.pathname.startsWith('/signin')) {
        console.log('Login abgeschlossen, finale URL:', currentUrl);
        return;
      }
    } catch {
      // falls URL-Parsing schiefgeht, einfach weitermachen
    }

    // 1) E-Mail-Maske (nur wenn Feld NICHT disabled)
    const emailLocator = page.getByLabel('E-Mail-Adresse');
    let emailVisible = false;
    let emailDisabled = false;

    try {
      emailVisible = await emailLocator.isVisible({ timeout: 2000 });
      if (emailVisible) {
        // isDisabled() kann werfen, daher separat in try
        try {
          emailDisabled = await emailLocator.isDisabled();
        } catch {
          emailDisabled = false;
        }
      }
    } catch {
      emailVisible = false;
      emailDisabled = false;
    }

    if (emailVisible && !emailDisabled) {
      console.log('E-Mail-Maske sichtbar (aktiv) → fülle E-Mail & klicke "Weiter".');

      await emailLocator.fill(email);

      const weiterButton = page.getByRole('button', { name: 'Weiter' });
      await Promise.all([
        weiterButton.click(),
        page.waitForLoadState('networkidle'),
      ]);

      continue; // zurück zum Schleifenanfang
    }

    if (emailVisible && emailDisabled) {
      console.log(
        'E-Mail-Feld ist sichtbar, aber deaktiviert (vorbefüllt) → überspringe E-Mail-Logik und prüfe Passwort-Maske.'
      );
      // Kein "Weiter"-Klick mehr hier – wir gehen direkt zur Passwort-Variante unten
    }

    // 2) Passwort-Maske?
    // gezielt das Passwort-Input, NICHT den "Passwort anzeigen"-Button
    const passwordInput = page.locator(
      'input[type="password"][autocomplete="current-password"]'
    );
    let passwordVisible = false;
    try {
      passwordVisible = await passwordInput.isVisible({ timeout: 2000 });
    } catch {
      passwordVisible = false;
    }

    if (passwordVisible) {
      console.log('Passwort-Maske sichtbar → fülle Passwort & klicke "Einloggen".');

      await passwordInput.fill(password);

      const loginButton = page.getByRole('button', { name: 'Einloggen' });
      await Promise.all([
        loginButton.click(),
        page.waitForLoadState('networkidle'),
      ]);

      continue; // ggf. noch ein weiterer /signin-Schritt (z. B. two-factor)
    }

    // 3) Weder E-Mail noch Passwort-Feld explizit gefunden → kurz warten
    console.log(
      'Weder aktive E-Mail- noch Passwort-Maske eindeutig gefunden – warte kurz und prüfe erneut …'
    );
    await page.waitForTimeout(2000);
  }

  throw new Error(
    `Login konnte nach mehreren Versuchen nicht abgeschlossen werden; aktuelle URL: ${page.url()}`
  );
}

// -------------------------------------------------------------
// Statistik-Export
// -------------------------------------------------------------

async function exportStatistics(page, orgId, fromDate, toDate) {
  const statsUrl = `https://pro.doctolib.de/configuration/statistics/queries?organization_id=${orgId}`;
  console.log('Öffne Statistik-Seite –', statsUrl);
  await page.goto(statsUrl, { waitUntil: 'domcontentloaded' });

  // Wenn Doctolib uns hier wieder auf /signin wirft, ist etwas mit Login/Sicherheit nicht ok
  if (page.url().includes('/signin')) {
    throw new Error(
      `Beim Öffnen der Statistikseite wieder auf /signin gelandet (mögliche Sicherheitsabfrage / 2FA). URL: ${page.url()}`
    );
  }

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
  try {
    if (await deletedCheckbox.isChecked()) {
      await deletedCheckbox.uncheck();
    }
  } catch {
    // falls Checkbox nicht existiert, ignorieren
  }

  const exportsDir = await ensureExportsDir();
  const targetPath = path.join(
    exportsDir,
    `doctolib_${fromDate}_${toDate}.csv`
  );

  console.log('Starte CSV-Export …');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.getByRole('button', { name: 'Exportieren' }).click(),
  ]);

  const suggested = download.suggestedFilename();
  console.log('Vorgeschlagener Dateiname von Doctolib:', suggested);

  await download.saveAs(targetPath);
  console.log('CSV gespeichert unter:', targetPath);
}

// -------------------------------------------------------------
// Main
// -------------------------------------------------------------

async function main() {
  const email = getRequiredEnv('DOCTOLIB_EMAIL');
  const password = getRequiredEnv('DOCTOLIB_PASSWORD');
  const orgId = getRequiredEnv('DOCTOLIB_ORG_ID');
  const { from, to } = getDateRangeFromEnv();

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
    console.log('Doctolib-Export erfolgreich abgeschlossen.');
  } catch (err) {
    console.error('Fehler im Doctolib-Export:', err.message || err);

    try {
      const exportsDir = await ensureExportsDir();
      const screenshotPath = path.join(exportsDir, 'error-login.png');
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
