// check_icai_hyderabad_only.js
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  // --- CONFIGURATION ---
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  const SMTP_HOST = process.env.SMTP_HOST;
  const SMTP_PORT = process.env.SMTP_PORT;
  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASS = process.env.SMTP_PASS;
  const EMAIL_TO = process.env.EMAIL_TO;

  const targetURL = 'https://www.icaionlineregistration.org/LaunchBatchDetail.aspx';

  const coursesToCheck = [
    'Advanced (ICITSS) MCS Course',
    'Advanced Information Technology'
  ];
  // ---------------------

  // Helper: Send Notification
  async function notify(subject, message) {
    console.log(`\n--- SENDING NOTIFICATION: ${subject} ---`);
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
      try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `${subject}\n\n${message}` })
        });
        console.log('Telegram sent.');
      } catch (e) { console.error('Telegram error:', e.message); }
    }
    if (SMTP_HOST && SMTP_USER && EMAIL_TO) {
      try {
        const transporter = nodemailer.createTransport({
          host: SMTP_HOST,
          port: Number(SMTP_PORT),
          secure: Number(SMTP_PORT) === 465,
          auth: { user: SMTP_USER, pass: SMTP_PASS }
        });
        await transporter.sendMail({ from: SMTP_USER, to: EMAIL_TO, subject, text: message });
        console.log('Email sent.');
      } catch (e) { console.error('Email error:', e.message); }
    }
  }

  // --- BROWSER SETUP ---
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  async function findAndSelect(selectors, visibleText) {
    for (const sel of selectors) {
      try {
        const handle = await page.$(sel);
        if (!handle) continue;
        const opts = await handle.$$eval('option', options => options.map(o => ({ value: o.value, text: o.innerText.trim() })));
        const match = opts.find(o => o.text.toLowerCase().includes(visibleText.toLowerCase()));
        if (match) {
          await handle.selectOption(match.value);
          await handle.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  async function clickGetList() {
    try {
      const btn = await page.$('input[value*="Get List"], button, input[type="submit"]');
      if (btn) { await btn.click({ timeout: 5000 }); return true; }
    } catch(e) {}
    return false;
  }

  try {
    console.log('Navigating...');
    await page.goto(targetURL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000);

    // 1. Select Region (Southern)
    const regionOk = await findAndSelect(['#ddl_reg', 'select[name*="region"]'], 'Southern');
    if (!regionOk) throw new Error("Could not select Region: Southern");
    await sleep(1500);
    
    // 2. Select POU (HYDERABAD) - STRICT CHECK
    const pouOk = await findAndSelect(['#ddl_pou', 'select[name*="pou"]'], 'HYDERABAD');
    if (!pouOk) {
        throw new Error("CRITICAL: Could not select POU 'HYDERABAD'. Aborting to avoid wrong data.");
    }
    await sleep(1500);

    // 3. Iterate Courses
    for (const courseName of coursesToCheck) {
      console.log(`\nChecking Course: ${courseName}`);

      const courseOk = await findAndSelect(['#ddl_course', 'select[name*="course"]'], courseName);
      if (!courseOk) {
        console.warn(`Could not select course: ${courseName}`);
        continue;
      }

      await clickGetList();
      await sleep(2500);

      // Scrape Table
      const rawBatches = await page.evaluate(() => {
        const tbl = document.querySelector('table[class*="grid"]') || document.querySelector('table');
        if (!tbl) return [];
        
        const headerRow = Array.from(tbl.rows).find(r => r.innerText.match(/Available\s*Seats/i));
        if (!headerRow) return [];
        const colIdx = Array.from(headerRow.cells).findIndex(c => c.innerText.match(/Available\s*Seats/i));
        
        return Array.from(tbl.rows).slice(1).map(row => {
          const cells = Array.from(row.cells).map(c => c.innerText.trim());
          const seatsStr = (colIdx > -1 && cells[colIdx]) ? cells[colIdx] : '0';
          return { batch: cells[0] || 'Unknown', seats: seatsStr };
        });
      });

      // FILTER: Only keep batches containing "HYDERABAD"
      const hydBatches = rawBatches.filter(b => b.batch.toUpperCase().includes('HYDERABAD'));

      if (hydBatches.length > 0) {
        // Create message list
        const lines = hydBatches.map(r => `• ${r.batch} -> ${r.seats} seats`);
        const msg = `Hyderabad Batches for ${courseName}:\n\n${lines.join('\n')}\n\n${targetURL}`;
        await notify(`Hyderabad Status: ${courseName}`, msg);
      } else {
        console.log(`No Hyderabad batches found for ${courseName}.`);
        // Optional: Notify even if list is empty? Uncomment below if you want "No batches" alerts.
        // await notify(`Hyderabad Status: ${courseName}`, "No batches found.");
      }

      await sleep(1000);
    }

  } catch (err) {
    console.error('Script Error:', err.message);
  } finally {
    await browser.close();
    process.exit(0);
  }
})();
