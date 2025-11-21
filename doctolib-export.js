async function login(page) {
  console.log('Gehe zur Login-Seite …');
  await page.goto('https://pro.doctolib.de/login', { waitUntil: 'networkidle' });

  page.setDefaultTimeout(60000);

  // 1) Cookie-Banner weg, falls vorhanden (best-effort)
  try {
    const consentButton = page
      .getByRole('button', { name: /akzeptieren|zustimmen|alle akzeptieren/i })
      .first();
    if (await consentButton.isVisible()) {
      console.log('Klicke Cookie/Consent-Button …');
      await consentButton.click();
      await page.waitForTimeout(1000);
    }
  } catch (_) {
    // ignorieren, wenn nicht vorhanden
  }

  // 2) E-Mail / Username
  const emailLocator = page.locator('input[autocomplete="username"], input[type="email"]').first();
  console.log('Warte auf E-Mail-Feld …');
  await emailLocator.waitFor();
  await emailLocator.fill(DOCTOLIB_USER);

  // 3) Passwort
  const passwordLocator = page.locator('input[autocomplete="current-password"], input[type="password"]').first();
  console.log('Warte auf Passwort-Feld …');
  await passwordLocator.waitFor();
  await passwordLocator.fill(DOCTOLIB_PASS);

  // 4) Submit-Button
  const submitButton = page.locator(
    [
      'button[type="submit"]',
      'button:has-text("Anmelden")',
      'button:has-text("Einloggen")',
      'button:has-text("Login")'
    ].join(', ')
  ).first();

  console.log('Sende Login-Formular ab …');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    submitButton.click()
  ]);

  console.log('Login abgeschlossen, aktuelle URL:', page.url());
}
