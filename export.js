const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_URL = process.env.INSIGHTS_BASE_URL || 'https://dbinsights-production.doctolib.fr';
const INSIGHTS_PATH = process.env.INSIGHTS_PATH; // z.B. "/chart_caches?path=..."
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, 'exports');
const OUTPUT_NAME = process.env.OUTPUT_NAME || 'doctolib_insights.csv';

if (!INSIGHTS_PATH) {
  console.error('INSIGHTS_PATH ist nicht gesetzt.');
  process.exit(1);
}

const fullUrl = BASE_URL + INSIGHTS_PATH;

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const outputPath = path.join(OUTPUT_DIR, OUTPUT_NAME);

console.log('Hole Daten von:', fullUrl);
console.log('Speichere nach:', outputPath);

https.get(fullUrl, (res) => {
  if (res.statusCode !== 200) {
    console.error('HTTP-Fehler:', res.statusCode);
    res.resume();
    process.exit(1);
  }

  const fileStream = fs.createWriteStream(outputPath);
  res.pipe(fileStream);

  fileStream.on('finish', () => {
    fileStream.close();
    console.log('Download abgeschlossen.');
  });
}).on('error', (err) => {
  console.error('Request-Fehler:', err);
  process.exit(1);
});
