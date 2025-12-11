// check_icai.js — improved resilient version
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  const SMTP_HOST = process.env.SMTP_HOST;
  const SMTP_PORT = process.env.SMTP_PORT;
  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASS = process.env.SMTP_PASS;
  const EMAIL_TO = process.env.EMAIL_TO;

  const targetURL = 'https://www.icaionlineregistration.org/launchbatchdetail.aspx';

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // helper: choose an option by visible text (fuzzy)
  async function selectOptionByText(selectHandle, text) {
    if (!selectHandle) return false;
    const opts = await selectHandle.$$eval('option', options => options.map(o => ({ value: o.value, text: o.innerText.trim() })));
    const match = opts.find(o => o.text.toLowerCase().includes(text.toLowerCase()));
    if (match) {
      await selectHandle.selectOption(match.value);
      // dispatch change event (some pages react only to DOM events)
      await selectHandle.evaluate((el) => {
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return true;
    }
    return false;
  }

  // helper: try multiple selector candidates for a select element
  async function findAndSelect(possibleSelectors, visibleText, maxRetries=4) {
    for (let attempt=0; attempt<maxRetries; ++attempt) {
      for (const sel of possibleSelectors) {
        try {
          const handle = await page.$(sel);
          if (!handle) continue;
          const ok = await selectOptionByText(handle, visibleText);
          if (ok) {
            console.log(`Selected "${visibleText}" using selector ${sel} (attempt ${attempt+1})`);
            return true;
          }
        } catch (e) {
          // continue
        }
      }
      // fallback: try scanning all SELECTs
      const allSelects = await page.$$('select');
      for (const h of allSelects) {
        try {
          const ok = await selectOptionByText(h, visibleText);
          if (ok) {
            console.log(`Selected "${visibleText}" using one of all <select> elements (attempt ${attempt+1})`);
            return true;
          }
        } catch (e) {}
      }
      // wait a bit for options to populate (AJAX)
      await sleep(1500 + attempt*500);
    }
    console.warn(`Failed to select "${visibleText}" after ${maxRetries} attempts.`);
    return false;
  }

  try {
    console.log('Navigating to target page...');
    await page.goto(targetURL, { waitUntil: 'networkidle', timeout: 60000 });

    // initial wait to let page JS populate selects
    await sleep(3000);

    // REGION: try a few common selectors (IDs observed or nth-of-type)
    const regionSelectors = ['#ddl_reg', 'select[name*="region"]', 'select:nth-of-type(1)'];
    const pouSelectors = ['#ddl_pou', 'select[name*="pou"]', 'select:nth-of-type(2)'];
    const courseSelectors = ['#ddl_course', 'select[name*="course"]', 'select:nth-of-type(3)'];

    const gotRegion = await findAndSelect(regionSelectors, 'Southern');
    // allow time for POU to load after region change
    if (gotRegion) await sleep(1500);

    const gotPou = await findAndSelect(pouSelectors, 'HYDERABAD');
    if (gotPou) await sleep(1500);

    const gotCourse = await findAndSelect(courseSelectors, 'Advanced (ICITSS) MCS Course');
    if (!gotRegion || !gotPou || !gotCourse) {
      console.warn('One or more selections not confirmed; continuing to try clicking Get List anyway.');
    }

    // Attempt to click Get List more robustly: try common button selectors
    const btnXPaths = [
      `//input[@type="button" and contains(@value,"Get List")]`,
      `//input[@type="button" and contains(@value,"GetList")]`,
      `//button[contains(text(),"Get List")]`,
      `//a[contains(text(),"Get List")]`,
      `//input[@type="submit" and contains(@value,"Get List")]`
    ];
    let clicked = false;
    for (const xp of btnXPaths) {
      const el = await page.$(`xpath=${xp}`);
      if (el) { try { await el.click({ timeout: 5000 }); clicked = true; console.log('Clicked Get List via xpath', xp); break; } catch(e){ console.warn('click failed', xp, e.message);} }
    }
    if (!clicked) {
      const btnFallback = await page.$('input[type="button"], button, a');
      if (btnFallback) { await btnFallback.click().catch(()=>{}); clicked = true; console.log('Clicked first button fallback'); }
    }
    if (!clicked) console.warn('Could not find a Get List button to click.');

    // wait for results to load
    await sleep(3000);

    // try multiple ways to locate a table or results container
    const possibleTableSelectors = [
      'table', // generic table
      '#ctl00_ContentPlaceHolder1_gvBatch', // common ASP.NET grid id pattern (example)
      'table[class*="grid"]',
      'div.results table',
      '#gvBatch'
    ];

    let tableHandle = null;
    for (const sel of possibleTableSelectors) {
      try {
        tableHandle = await page.$(sel);
        if (tableHandle) { console.log('Found table using selector:', sel); break; }
      } catch (e){}
    }

    // additional attempt: wait for any table to appear (up to 8s)
    if (!tableHandle) {
      try {
        tableHandle = await page.waitForSelector('table', { timeout: 8000 }).catch(()=>null);
        if (tableHandle) console.log('Found table by waiting for generic table selector.');
      } catch(e){}
    }

    if (!tableHandle) {
      // Save HTML snapshot for debugging to Action logs
      const html = await page.content();
      console.error('No table found after clicking Get List. Dumping page HTML to log for debugging...');
      // limit size but print relevant portion
      const snippet = html.slice(0, 20000); // first 20k chars
      console.error('--- PAGE HTML SNIPPET (first 20k chars) ---');
      console.error(snippet);
      console.error('--- END SNIPPET ---');
      await browser.close();
      throw new Error('No table found after clicking Get List.');
    }

    // determine column index for "Available Seats"
    const colIndex = await page.evaluate((tableSel) => {
      const tbl = document.querySelector(tableSel) || document.querySelector('table');
      if (!tbl) return -1;
      // find header row
      const headerRow = Array.from(tbl.querySelectorAll('tr')).find(r => Array.from(r.cells).some(c => /Available\\s*Seats/i.test(c.innerText)));
      if (!headerRow) return -1;
      const cells = Array.from(headerRow.cells).map(c => c.innerText.trim());
      const idx = cells.findIndex(c => /Available\\s*Seats/i.test(c));
      return idx;
    }, 'table');

    if (colIndex === -1) {
      console.warn('Could not detect "Available Seats" header; will fallback to scanning numeric cells.');
    }

    const seatInfo = await page.evaluate((colIndex) => {
      const tbl = document.querySelector('table');
      if (!tbl) return [];
      const rows = Array.from(tbl.querySelectorAll('tr')).slice(1);
      const results = [];
      rows.forEach(row => {
        const cells = Array.from(row.cells).map(c => c.innerText.trim());
        let batch = cells[0] || '';
        let seats = null;
        if (colIndex >= 0 && cells[colIndex]) seats = cells[colIndex];
        if ((seats === null || seats === '') && cells.length > 0) {
          for (const c of cells) {
            if (/^\\d+$/.test(c)) { seats = c; break; }
          }
        }
        results.push({ batch, seats });
      });
      return results;
    }, colIndex);

    await browser.close();

    const positive = seatInfo.filter(r => {
      const val = r.seats ? r.seats.replace(/\\D/g,'') : '';
      return val !== '' && parseInt(val,10) > 0;
    });

    if (positive.length > 0) {
      const msg = `ICAI seats available!\\n${positive.map(p => `${p.batch} → ${p.seats}`).join('\\n')}\\n${targetURL}`;
      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await fetch(tgUrl, {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
        });
      }
      if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && EMAIL_TO) {
        const transporter = nodemailer.createTransport({
          host: SMTP_HOST,
          port: Number(SMTP_PORT),
          secure: Number(SMTP_PORT) === 465,
          auth: { user: SMTP_USER, pass: SMTP_PASS }
        });
        await transporter.sendMail({ from: SMTP_USER, to: EMAIL_TO, subject: 'ICAI seats available!', text: msg });
      }
      console.log('ALERT: seats available!', positive);
      process.exit(0);
    } else {
      console.log('No seats currently available.');
      process.exit(0);
    }

  } catch (err) {
    console.error('Script error:', err);
    try { await browser.close(); } catch(e){}
    process.exit(2);
  }
})();
