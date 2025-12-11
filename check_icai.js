// check_icai_all_seats.js
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

  // Helper: Send Notification (Telegram + Email)
  async function notify(subject, message) {
    console.log(`\n--- SENDING NOTIFICATION: ${subject} ---`);
    
    // 1. Telegram
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
      const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
      try {
        await fetch(tgUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `${subject}\n\n${message}` })
        });
        console.log('Telegram sent.');
      } catch (e) {
        console.error('Telegram failed:', e.message);
      }
    }

    // 2. Email
    if (SMTP_HOST && SMTP_USER && EMAIL_TO) {
      try {
        const transporter = nodemailer.createTransport({
          host: SMTP_HOST,
          port: Number(SMTP_PORT),
          secure: Number(SMTP_PORT) === 465,
          auth: { user: SMTP_USER, pass: SMTP_PASS }
        });
        await transporter.sendMail({
          from: SMTP_USER,
          to: EMAIL_TO,
          subject: subject,
          text: message
        });
        console.log('Email sent.');
      } catch (e) {
        console.error('Email failed:', e.message);
      }
    }
  }

  // --- BROWSER SETUP ---
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Helper: Select option by text (fuzzy match)
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
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  // Helper: Click "Get List"
  async function clickGetList() {
    const btnSelectors = [
      'input[value*="Get List"]', 'input[value*="GetList"]', 
      'button', 'input[type="submit"]'
    ];
    for (const s of btnSelectors) {
      const el = await page.$(s);
      if (el) {
        try { 
            const val = await el.getAttribute('value');
            const txt = await el.innerText();
            if((val && val.includes('Get')) || (txt && txt.includes('Get'))) {
                await el.click({ timeout: 5000 }); 
                return true; 
            }
        } catch (e) {}
      }
    }
    try { await page.click('input[type="button"]'); return true; } catch(e) { return false; }
  }

  try {
    console.log('Navigating...');
    await page.goto(targetURL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000);

    // 1. Select Region & POU (Done once)
    await findAndSelect(['#ddl_reg', 'select[name*="region"]'], 'Southern');
    await sleep(1500);
    
    await findAndSelect(['#ddl_pou', 'select[name*="pou"]'], 'HYDERABAD');
    await sleep(1500);

    // 2. Iterate Courses
    for (const courseName of coursesToCheck) {
      console.log(`\nChecking: ${courseName}`);

      // Select Course
      const courseOk = await findAndSelect(['#ddl_course', 'select[name*="course"]'], courseName);
      if (!courseOk) console.warn(`Could not select ${courseName}`);

      // Click Get List
      await clickGetList();
      await sleep(2500);

      // Scrape Table (Get ALL rows, regardless of seat count)
      const batchData = await page.evaluate(() => {
        const tbl = document.querySelector('table[class*="grid"]') || document.querySelector('table');
        if (!tbl) return [];
        
        // Find column index for "Available Seats"
        const headerRow = Array.from(tbl.rows).find(r => r.innerText.match(/Available\s*Seats/i));
        if (!headerRow) return [];
        const colIdx = Array.from(headerRow.cells).findIndex(c => c.innerText.match(/Available\s*Seats/i));
        
        // Parse rows
        return Array.from(tbl.rows).slice(1).map(row => {
          const cells = Array.from(row.cells).map(c => c.innerText.trim());
          const seatsStr = (colIdx > -1 && cells[colIdx]) ? cells[colIdx] : '0';
          // Keep raw seat string or default to "0"
          return { batch: cells[0], seats: seatsStr };
        });
      });

      // --- IMMEDIATE NOTIFICATION ---
      // We send a message regardless of whether seats are > 0 or not.
      if (batchData.length > 0) {
        const lines = batchData.map(r => `• ${r.batch} -> ${r.seats} seats`);
        const msg = `Status for ${courseName}:\n\n${lines.join('\n')}\n\n${targetURL}`;
        await notify(`ICAI Status: ${courseName}`, msg);
      } else {
        await notify(`ICAI Status: ${courseName}`, `No batches found in the table.`);
      }

      await sleep(1000);
    }

  } catch (err) {
    console.error('Fatal Error:', err);
  } finally {
    await browser.close();
    process.exit(0);
  }
})();
