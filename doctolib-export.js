// doctolib-export.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DOCTOLIB_USER = process.env.DOCTOLIB_USER;
const DOCTOLIB_PASS = process.env.DOCTOLIB_PASS;
const DOCTOLIB_STATS_URL = process.env.DOCTOLIB_STATS_URL; // Statistik-URL (Termine)
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, 'exports');

// Standard: wahrgenommene Termine, Gruppierung nach Terminkalender
const DATE_FILTERING = process.env.DATE_FILTERING || 'start_date'; // 'start_date' oder 'created_at'
const PRIMARY_GROUP = process.env.PRIMARY_GROUP || 'agenda';       // z.B. 'agenda', 'start_date_day', 'status'
const SECONDARY_GROUP = process.env.SECONDARY_GROUP || '';         // '' für "Keine"
const EXCLUDE_STATUSES = (process.env.EXCLUDE_STATUSES || 'deleted')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Hilfsfunktionen -------------------------------------------------

function getLastMonthRange() {
  const now = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDayLastMonth = new Date(firstOfThisMonth.getTime() - 1);
  const firstDayLastMonth = new Date(lastDayLastMonth.getFullYear(), lastDayLastMonth.getMonth(), 1);

  const fmt = d => d.toISOString().slice(0, 10); // JJJJ-MM-TT
  return {
    start: fmt(firstDayLastMonth),
    end: fmt(lastDayLastMonth)
  };
}

async function login(page) {
  console.log('Login …');
  await page.goto('https://pro.doctolib.de/login', { waitUntil: 'networkidle' });

  await page.fill('input[name="username"], input[type="email"]', DOCTOLIB_USER);
  await page.fill('input[type="password"]', DOCTOLIB_PASS);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('button[type="submit"]')
  ]);

  console.log('Login abgeschlossen.');
}

async function openStatistics(page, startDate, endDate) {
  console.log('Öffne Statistik-Ansicht …');
  await page.goto(DOCTOLIB_STATS_URL, { waitUntil: 'networkidle' });

  console.log(`Setze Zeitraum: ${startDate} bis ${endDate}`);
  await page.fill('#from', startDate);
  await page.fill('#to', endDate);
  await page.waitForTimeout(1500);
}

async function configureStatistics(page) {
  console.log('Konfiguriere Statistik (Termine, Gruppierung, Status-Filter) …');

  // Statistik zu: Termine
  await page.selectOption('#table', 'appointment');

  // Statistik der: wahrgenommenen / gebuchten Termine
  await page.selectOption('#date_filtering', DATE_FILTERING);

  // Gruppierung: primary / secondary
  await page.selectOption('#appointment_group', PRIMARY_GROUP);
  await page.selectOption('#appointment_second_group', SECONDARY_GROUP || '');

  // Auswahl-Feld: Anzahl an Terminen
  await page.selectOption('#appointment_select', 'appointment_count');

  // Status-Filter setzen
  const allStatusValues = [
    'done',
    'no_show',
    'no_show_but_ok',
    'waiting',
    'confirmed',
    'deleted',
    'in_progress',
    'rescheduled',
    'suspended'
  ];

  const excludeSet = new Set(EXCLUDE_STATUSES);
  console.log('Auszuschließende Status:', Array.from(excludeSet).join(', ') || '(keine)');

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

async function exportStatistics(page, startDate, endDate) {
  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }

  console.log('Starte Export …');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('input[name="csv"]') // dein „Exportieren“-Button
  ]);

  const suggested = await download.suggestedFilename();
  const startSafe = startDate.replace(/:/g, '-');
  const endSafe = endDate.replace(/:/g, '-');
  const filename = `doctolib_${startSafe}_${endSafe}_${suggested}`;
  const filePath = path.join(EXPORT_DIR, filename);

  await download.saveAs(filePath);
  console.log('Export gespeichert:', filePath);

  return filePath;
}

// Main ------------------------------------------------------------

(async () => {
  if (!DOCTOLIB_USER || !DOCTOLIB_PASS || !DOCTOLIB_STATS_URL) {
    console.error('Fehlende Umgebungsvariablen: DOCTOLIB_USER, DOCTOLIB_PASS, DOCTOLIB_STATS_URL sind Pflicht.');
    process.exit(1);
  }

  const { start, end } = getLastMonthRange();
  console.log(`Zeitraum (letzter Monat): ${start} – ${end}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await login(page);
    await openStatistics(page, start, end);
    await configureStatistics(page);
    await exportStatistics(page, start, end);
    console.log('Fertig.');
  } catch (err) {
    console.error('Fehler beim Doctolib-Export:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
