const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DOCTOLIB_USER = process.env.DOCTOLIB_USER;
const DOCTOLIB_PASS = process.env.DOCTOLIB_PASS;
const DOCTOLIB_ORG_ID = process.env.DOCTOLIB_ORG_ID; // z.B. 263702
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, 'exports');

const DATE_FILTERING = process.env.DATE_FILTERING || 'start_date'; // 'start_date' = wahrgenommenen
const PRIMARY_GROUP = process.env.PRIMARY_GROUP || 'agenda';       // 'agenda' = Terminkalender
const SECONDARY_GROUP = process.env.SECONDARY_GROUP || '';
const EXCLUDE_STATUSES = (process.env.EXCLUDE_STATUSES || 'deleted')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!DOCTOLIB_USER || !DOCTOLIB_PASS || !DOCTOLIB_ORG_ID) {
  console.error('DOCTOLIB_USER, DOCTOLIB_PASS, DOCTOLIB_ORG_ID müssen gesetzt sein.');
  process.exit(1);
}

function lastMonthRange() {
  const now = new Date();
  const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastLastMonth = new Date(firstThisMonth.getTime() - 1);
  const firstLastMonth = new Date(lastLastMonth.getFullYear(), lastLastMonth.getMonth(), 1);
  const fmt = d => d.toISOString().slice(0, 10);
  return { start: fmt(firstLastMonth), end: fmt(lastLastMonth) };
}

async function login(page) {
  await page.goto('https://pro.doctolib.de/login', { waitUntil: 'networkidle' });
  await page.fill('input[name="username"], input[type="email"]', DOCTOLIB_USER);
  await page.fill('input[type="password"]', DOCTOLIB_PASS);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('button[type="submit"]')
  ]);
}

async function openStats(page, start, end) {
  const url = `https://pro.doctolib.de/configuration/statistics/queries?organization_id=${DOCTOLIB_ORG_ID}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.fill('#from', start);
  await page.fill('#to', end);
  await page.waitForTimeout(1500);
}

async function configureStats(page) {
  await page.selectOption('#table', 'appointment');             // Termine
  await page.selectOption('#date_filtering', DATE_FILTERING);   // wahrgenommen / gebucht
  await page.selectOption('#appointment_group', PRIMARY_GROUP);
  await page.selectOption('#appointment_second_group', SECONDARY_GROUP || '');
  await page.selectOption('#appointment_select', 'appointment_count');

  const allStatus = [
    'done', 'no_show', 'no_show_but_ok',
    'waiting', 'confirmed', 'deleted',
    'in_progress', 'rescheduled', 'suspended'
  ];
  const excludeSet = new Set(EXCLUDE_STATUSES);

  for (const value of allStatus) {
    const selector = `input[name="status_filters[]"][value="${value}"]`;
    const el = await page.$(selector);
    if (!el) continue;
    const shouldExclude = excludeSet.has(value);
    const checked = await el.isChecked();
    if (shouldExclude && !checked) await el.check();
    if (!shouldExclude && checked) await el.uncheck();
  }
}

async function exportStats(page, start, end) {
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('input[name="csv"]') // Button "Exportieren"
  ]);

  const suggested = await download.suggestedFilename();
  const fileName = `doctolib_${start}_${end}_${suggested}`;
  const filePath = path.join(EXPORT_DIR, fileName);
  await download.saveAs(filePath);
  console.log('Export gespeichert:', filePath);
}

(async () => {
  const { start, end } = lastMonthRange();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await login(page);
    await openStats(page, start, end);
    await configureStats(page);
    await exportStats(page, start, end);
  } catch (e) {
    console.error('Fehler im Export:', e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
