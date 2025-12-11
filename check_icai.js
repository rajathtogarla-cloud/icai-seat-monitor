// check_icai.js
// Node 18+ recommended. Uses Playwright to open the page, select values, click Get List,
// parse the "Available Seats" column and notify via Telegram (+ optional email).

const { chromium } = require('playwright');
const fetch = require('node-fetch'); // node 18+ has fetch natively; included for older node
const nodemailer = require('nodemailer');

(async () => {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  const SMTP_HOST = process.env.SMTP_HOST;           // optional
  const SMTP_PORT = process.env.SMTP_PORT;           // optional
  const SMTP_USER = process.env.SMTP_USER;           // optional
  const SMTP_PASS = process.env.SMTP_PASS;           // optional
  const EMAIL_TO = process.env.EMAIL_TO;             // optional

  const targetURL = 'https://www.icaionlineregistration.org/launchbatchdetail.aspx';

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await page.goto(targetURL, { waitUntil: 'networkidle' , timeout: 60000 });

    // Wait for selects to appear (page uses javascript)
    await page.waitForTimeout(7000);

    // Helper to select an option by visible text for a <select> element
    async function selectByLabel(selectLocator, visibleText) {
      const options = await page.$$eval(`${selectLocator} option`, opts => opts.map(o => ({ value: o.value, text: o.innerText.trim() })));
      const match = options.find(o => o.text.toLowerCase().includes(visibleText.toLowerCase()));
      if (match) {
        await page.selectOption(selectLocator, match.value);
        return true;
      }
      return false;
    }

    // Try common select selectors — adjust if necessary
    // We attempt to find the select elements automatically.
    // 1) Region -> look for select elements and match option text "Southern"
    // 2) POU -> match "HYDERABAD"
    // 3) Course -> match "Advanced" or "MCS"
    const allSelects = await page.$$('select');
    if (allSelects.length === 0) {
      throw new Error('No select elements found on the page. The page structure might have changed.');
    }

    // Try selecting by scanning each select element for the desired option
    const desired = [
      { text: 'Southern' },
      { text: 'HYDERABAD' },
      { text: 'Advanced (ICITSS) MCS' } // partial match allowed
    ];

    for (let i = 0; i < desired.length; ++i) {
      let found = false;
      for (let idx = 0; idx < allSelects.length; ++idx) {
        const selector = `select:nth-of-type(${idx+1})`;
        const ok = await selectByLabel(selector, desired[i].text);
        if (ok) { found = true; break; }
      }
      if (!found) {
        // fallback: try global select by matching option text across all selects
        let matched = false;
        for (const s of allSelects) {
          const handle = await s;
          const opts = await handle.$$eval('option', opts => opts.map(o=>o.innerText.trim()));
          if (opts.some(t => t.toLowerCase().includes(desired[i].text.toLowerCase()))) {
            // use the handle's selector index to select
            // we already attempted selectByLabel, so if we reach here, do nothing
            matched = true; break;
          }
        }
        // if still not matched, continue (may still work)
      }
    }

    // Click "Get List" button — try multiple ways
    // Many ICAI pages use an <input type="button" value="Get List"> or <a> with text 'Get List'
    const btnTexts = ['Get List', 'GetList', 'GetListButton'];
    let clicked = false;

    // try to click button by value or text
    for (const t of ['Get List', 'GetList']) {
      const btn = await page.$(`xpath=//input[@type="button" and contains(@value,"${t}")] | //button[contains(text(),"${t}")] | //a[contains(text(),"${t}")]`);
      if (btn) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      // fallback: click first button on the page (risky)
      const btn2 = await page.$('input[type="button"]');
      if (btn2) { await btn2.click(); clicked = true; }
    }
    // wait for results to load
    await page.waitForTimeout(3000);
    // Wait for table load
    await page.waitForSelector('table', { timeout: 15000 }).catch(()=>{});

    // Find table and parse header to locate "Available Seats" column index
    const table = await page.$('table');
    if (!table) {
      throw new Error('No table found after clicking Get List.');
    }

    const colIndex = await page.evaluate(() => {
      const tbl = document.querySelector('table');
      if (!tbl) return -1;
      const headers = tbl.querySelectorAll('th,td');
      // try to find header row's cells with the text 'Available Seats'
      const ths = Array.from(tbl.querySelectorAll('tr')).find(r => Array.from(r.cells).some(c => /Available\\s*Seats/i.test(c.innerText)));
      if (!ths) {
        return -1;
      }
      const cells = Array.from(ths.cells).map(c => c.innerText.trim());
      const idx = cells.findIndex(c => /Available\\s*Seats/i.test(c));
      return idx;
    });

    if (colIndex === -1) {
      // attempt alternate approach: assume Available Seats is column 1 or 2; we'll search all numeric cells
      console.warn('Could not detect Available Seats header. Will scan numeric columns for >0.');
    }

    // get rows and seat values
    const seatInfo = await page.evaluate((colIndex) => {
      const tbl = document.querySelector('table');
      if (!tbl) return [];
      const rows = Array.from(tbl.querySelectorAll('tr')).slice(1); // skip header-ish row
      const results = [];
      rows.forEach(row => {
        const cells = Array.from(row.cells).map(c => c.innerText.trim());
        // attempt to get batchno and available seats
        let batch = cells[0] || '';
        let seats = null;
        if (colIndex >= 0 && cells[colIndex]) seats = cells[colIndex];
        // fallback: find first numeric cell
        if ((seats === null || seats === '') && cells.length > 0) {
          for (const c of cells) {
            if (/^\\d+$/.test(c)) { seats = c; break; }
          }
        }
        results.push({ batch: batch, seats: seats });
      });
      return results;
    }, colIndex);

    await browser.close();

    // Check seat numbers
    const positive = seatInfo.filter(r => {
      const val = r.seats ? r.seats.replace(/\\D/g,'') : '';
      return val !== '' && parseInt(val,10) > 0;
    });

    if (positive.length > 0) {
      const msg = `ICAI seats available!\\n${positive.map(p => `${p.batch} → ${p.seats}`).join('\\n')}\\n${targetURL}`;

      // Telegram notify
      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await fetch(tgUrl, {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
        });
      }

      // Email notify via SMTP if provided
      if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && EMAIL_TO) {
        const transporter = nodemailer.createTransport({
          host: SMTP_HOST,
          port: Number(SMTP_PORT),
          secure: Number(SMTP_PORT) === 465,
          auth: {
            user: SMTP_USER,
            pass: SMTP_PASS
          }
        });
        await transporter.sendMail({
          from: SMTP_USER,
          to: EMAIL_TO,
          subject: 'ICAI seats available!',
          text: msg
        });
      }

      // Also echo to console
      console.log('ALERT: seats available!');
      console.log(positive);
      process.exit(0);
    } else {
      console.log('No seats currently available.');
      process.exit(0);
    }

  } catch (err) {
    console.error('Script error:', err);
    await browser.close();
    process.exit(2);
  }
})();
