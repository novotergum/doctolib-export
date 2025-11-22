// doctolib-export.js
// Läuft als ES-Modul (package.json: { "type": "module" })

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { promises: fsp } = fs;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXPORT_DIR = path.join(__dirname, 'exports');
const STORAGE_STATE_PATH = path.join(__dirname, 'storageState.json');

const {
  DOCTOLIB_EMAIL,
  DOCTOLIB_PASSWORD,
  DOCTOLIB_ORG_ID,
  DOCTOLIB_FROM,
  DOCTOLIB_TO,
} = process.env;

// ------------------------ Helpers: Datum & Verzeichnisse ------------------------

function computeDefaultRange() {
  const now = new Date();
  const firstThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const firstLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastLastMonth = new Date(firstThisMonth.getTime() - 24 * 3600 * 1000);

  const pad = (n) => String(n).padStart(2, '0');

  const from = `${firstLastMonth.getUTCFullYear()}-${pad(firstLastMonth.getUTCMonth() + 1)}-${pad(firstLastMonth.getUTCDate())}`;
  const to = `${lastLastMonth.getUTCFullYear()}-${pad(lastLastMonth.getUTCMonth() + 1)}-${pad(lastLastMonth.getUTCDate())}`;

  return { from, to };
}

function getDateRangeFromEnv() {
  if (DOCTOLIB_FROM && DOCTOLIB_TO) {
    return { from: DOCTOLIB_FROM, to: DOCTOLIB_TO };
  }
  const { from, to } = computeDefaultRange();
  console.log(`DOCTOLIB_FROM/TO nicht gesetzt – nutze letzten vollen Monat: ${from} – ${to}`);
  return { from, to };
}

async function ensureExportsDir() {
  await fsp.mkdir(EXPORT_DIR, { recursive: true });
}

// ------------------------ Cookie-Banner schließen ------------------------

async function closeCookieBannerIfPresent(page) {
  try {
    // Didomi-Overlay
    const didomiHost = page.locator('#didomi-host');
    if (await didomiHost.isVisible({ timeout: 500 }).catch(() => false)) {
      const acceptSelectors = [
        'button:has-text("Akzeptieren")',
        'button:has-text("Akzeptieren & schließen")',
        'button:has-text("Alle akzeptieren")',
      ];

      for (const sel of acceptSelectors) {
        const btn = page.locator(sel);
        if (await btn.isVisible().catch(() => false)) {
          console.log(`Cookie-Banner gefunden → klicke Button: ${sel}`);
          await btn.click();
          await page.waitForTimeout(500);
          break;
        }
      }
    }
  } catch {
    // Banner darf keinen harten Fehler auslösen
  }
}

// ------------------------ Login-Logik ------------------------

async function performLogin(page, { email, password, maxSteps = 10 }) {
  for (let step = 1; step <= maxSteps; step++) {
    const url = page.url();
    console.log(`Login-Loop Step ${step}, aktuelle URL: ${url}`);

    // 1) Immer zuerst Cookie-Banner wegräumen
    await closeCookieBannerIfPresent(page);

    // 2) Bereits im Pro-Bereich?
    if (
      url.includes('/configuration/statistics') ||
      url.includes('/agenda') ||
      url.includes('/appointments')
    ) {
      console.log('Login scheint bereits erfolgreich – im Pro-Bereich gelandet.');
      return;
    }

    // 3) E-Mail-Maske (Variante "Loggen Sie sich ein")
    const emailInput = page.locator(
      'input[autocomplete="username"][type="email"], input#input_:r0:'
    );

    const emailVisible = await emailInput.isVisible({ timeout: 500 }).catch(() => false);

    if (emailVisible) {
      const emailEnabled = await emailInput.isEnabled().catch(() => false);

      if (emailEnabled) {
        console.log('E-Mail-Maske sichtbar (aktiv) → fülle E-Mail & klicke „Weiter“.');
        await emailInput.fill(email);
      } else {
        console.log('E-Mail-Feld sichtbar, aber deaktiviert (vorbefüllt) → E-Mail nicht erneut setzen.');
      }

      const weiterBtn = page.getByRole('button', { name: /^Weiter$/ });
      try {
        await weiterBtn.waitFor({ state: 'visible', timeout: 5000 });
        await weiterBtn.click();
      } catch (err) {
        console.log('Konnte „Weiter“-Button nicht klicken, versuche Enter auf E-Mail-Feld.');
        try {
          await emailInput.press('Enter');
        } catch {
          console.log('Enter auf E-Mail-Feld ebenfalls nicht möglich.');
        }
      }

      await page.waitForTimeout(1500);
      continue;
    }

    // 4) Passwort-Masken (mehrere Varianten):

    // 4a) „Oxygen“-Variante (Nicht-eingeloggt-Flow, id="input_:r1:", class="oxygen-input-field__input")
    const passwordInputOxygen = page.locator(
      'input[autocomplete="current-password"][type="password"].oxygen-input-field__input'
    );

    // 4b) „Reauth“-Variante (eingeloggt, nur Passwort erneut abfragen, id="password")
    const passwordInputReauth = page.locator(
      'input#password[name="password"][type="password"][autocomplete="current-password"]'
    );

    // 4c) Fallback: irgendein current-password-Feld
    const passwordInputGeneric = page.locator(
      'input[autocomplete="current-password"][type="password"]'
    );

    let passwordInput = null;

    for (const candidate of [passwordInputOxygen, passwordInputReauth, passwordInputGeneric]) {
      if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
        passwordInput = candidate;
        break;
      }
    }

    if (passwordInput) {
      console.log('Passwort-Maske sichtbar → fülle Passwort & bestätige über Enter.');
      await passwordInput.fill(password);

      // Erst Enter auf dem Feld …
      try {
        await passwordInput.press('Enter');
      } catch {
        console.log('Enter auf Passwortfeld nicht möglich, versuche Login-Button.');
      }

      // … dann ggf. explizit "Einloggen"-Button klicken, falls vorhanden
      const einloggenBtn = page.getByRole('button', { name: /^Einloggen$/ });
      if (await einloggenBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        try {
          await einloggenBtn.click();
        } catch {
          // Wenn Klick nicht klappt, ist Enter ggf. schon ausreichend gewesen
        }
      }

      await page.waitForTimeout(2000);

      const newUrl = page.url();
      // Wenn wir nach dem Passwort nicht mehr auf /signin sind, sind wir sehr wahrscheinlich durch
      if (!/\/signin(\/|$)/.test(newUrl)) {
        console.log(`Nach Passwort-Eingabe nicht mehr auf /signin → vermutlich eingeloggt (URL: ${newUrl}).`);
        return;
      }

      // Prüfen, ob explizit der Hinweis-Text sichtbar ist (Reauth oder falsches PW),
      // aber NICHT automatisch abbrechen – wir machen ein paar Versuche.
      const reauthHint = page.locator(
        'text=Aus Sicherheitsgründen bitten wir Sie, Ihr Passwort einzugeben.'
      );
      if (await reauthHint.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('Hinweis „Aus Sicherheitsgründen …“ sichtbar – Reauth-Flow oder Passwort erneut nötig.');
      }

      continue;
    }

    // 5) Keine bekannte Login-Maske erkannt – einfach kurz warten und erneut prüfen
    console.log('Keine bekannte Login-Maske erkannt – warte kurz & prüfe erneut …');
    await page.waitForTimeout(1500);
  }

  // Wenn wir hier herausfallen, haben wir es in maxSteps nicht geschafft
  throw new Error(`Login konnte nicht abgeschlossen werden; aktuelle URL: ${page.url()}`);
}

// ------------------------ Hauptlogik ------------------------

async function main() {
  if (!DOCTOLIB_EMAIL || !DOCTOLIB_PASSWORD) {
    console.error('Bitte DOCTOLIB_EMAIL und DOCTOLIB_PASSWORD als Umgebungsvariablen setzen.');
    process.exit(1);
  }

  const { from, to } = getDateRangeFromEnv();

  await ensureExportsDir();

  const browser = await chromium.launch({ headless: true });
  let context;
  let page;

  try {
    if (fs.existsSync(STORAGE_STATE_PATH)) {
      console.log(`Nutze vorhandenes storageState: ${STORAGE_STATE_PATH}`);
      context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    } else {
      console.log('Kein gültiges storageState gefunden – starte mit leerem Kontext.');
      context = await browser.newContext();
    }

    page = await context.newPage();

    const loginUrl = 'https://pro.doctolib.de/signin';
    console.log(`Gehe zur Login-Seite – ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    await performLogin(page, {
      email: DOCTOLIB_EMAIL,
      password: DOCTOLIB_PASSWORD,
      maxSteps: 12,
    });

    // Nach Login speichern wir den storageState, damit Folge-Läufe evtl. direkt eingeloggt sind
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`storageState gespeichert unter: ${STORAGE_STATE_PATH}`);

    // ------------------------ Statistik-Seite ------------------------

    const orgId = DOCTOLIB_ORG_ID;
    const statsUrl = orgId
      ? `https://pro.doctolib.de/configuration/statistics?o=${encodeURIComponent(orgId)}`
      : 'https://pro.doctolib.de/configuration/statistics';

    console.log(`Gehe zur Statistik-Seite – ${statsUrl}`);
    await page.goto(statsUrl, { waitUntil: 'networkidle' });

    // Basic-Export: HTML + Screenshot (robust, unabhängig von internen API-URLs)
    const baseName = `statistics_${orgId || 'no-org'}_${from}_${to}`;
    const htmlPath = path.join(EXPORT_DIR, `${baseName}.html`);
    const pngPath = path.join(EXPORT_DIR, `${baseName}.png`);

    const html = await page.content();
    await fsp.writeFile(htmlPath, html, 'utf8');
    await page.screenshot({ path: pngPath, fullPage: true });

    console.log(`Statistik-HTML gespeichert unter: ${htmlPath}`);
    console.log(`Statistik-Screenshot gespeichert unter: ${pngPath}`);
  } catch (err) {
    console.error('Fehler im Doctolib-Export:', err && err.message ? err.message : err);
    try {
      if (page) {
        const errorPng = path.join(EXPORT_DIR, 'error-login.png');
        await page.screenshot({ path: errorPng, fullPage: true });
        console.log(`Fehler-Screenshot gespeichert unter: ${errorPng}`);
      }
    } catch {
      // Screenshot-Fehler ignorieren
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Unerwarteter Fehler im Hauptprozess:', err);
  process.exit(1);
});
