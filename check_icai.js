// check_icai.js — checks two courses and notifies if seats > 0
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
  async function findAndSelect(possibleSelectors, visibleText, maxRetries=5) {
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
      await sleep(1200 + attempt*500);
    }
    console.warn(`Failed to select "${visibleText}" after ${maxRetries} attempts.`);
    return false;
  }

  // clicking "Get List" helper
  async function clickGetList() {
    const btnXPaths = [
      `//input[@type="button" and contains(@value,"Get List")]`,
      `//input[@type="button" and contains(@value,"GetList")]`,
      `//button[contains(text(),"Get List")]`,
      `//a[contains(text(),"Get List")]`,
      `//input[@type="submit" and contains(@value,"Get List")]`
    ];
    for (const xp of btnXPaths) {
      const el = await page.$(`xpath=${xp}`);
      if (el) { try { await el.click({ timeout: 5000 }); console.log('Clicked Get List via xpath', xp); return true; } catch(e){ console.warn('click failed', xp, e.message);} }
    }
    const btnFallback = await page.$('input[type="button"], button, a');
    if (btnFallback) { await btnFallback.click().catch(()=>{}); console.log('Clicked first button fallback'); return true; }
    console.warn('Could not find a Get List button to click.');
    return false;
  }

  // parse table rows into [{batch, seats, rowCells...}, ...]
  async function parseTable() {
    // determine column index for "Available Seats"
    const colIndex = await page.evaluate(() => {
      const tbl = document.querySelector('table');
      if (!tbl) return -1;
      const headerRow = Array.from(tbl.querySelectorAll('tr')).find(r => Array.from(r.cells).some(c => /Available\s*Seats/i.test(c.innerText)));
      if (!headerRow) return -1;
      const cells = Array.from(headerRow.cells).map(c => c.innerText.trim());
      const idx = cells.findIndex(c => /Available\s*Seats/i.test(c));
      return idx;
    });

    // gather rows
    const rows = await page.evaluate((colIndex) => {
      const tbl = document.querySelector('table');
      if (!tbl) return [];
      const dataRows = Array.from(tbl.querySelectorAll('tr')).slice(1); // skip header-ish row
      const res = dataRows.map(row => {
        const cells = Array.from(row.cells).map(c => c.innerText.trim());
        let batch = cells[0] || '';
        let seats = null;
        if (colIndex >= 0 && cells[colIndex]) seats = cells[colIndex];
        if ((seats === null || seats === '') && cells.length > 0) {
          for (const c of cells) {
            if (/^\d+$/.test(c)) { seats = c; break; }
          }
        }
        return { batch, seats, raw: cells };
      });
      return res;
    }, colIndex);

    return rows;
  }

  try {
    console.log('Navigating to target page...');
    await page.goto(targetURL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(2500);

    // selectors for region/pou/course
    const regionSelectors = ['#ddl_reg', 'select[name*="region"]', 'select:nth-of-type(1)'];
    const pouSelectors = ['#ddl_pou', 'select[name*="pou"]', 'select:nth-of-type(2)'];
    const courseSelectors = ['#ddl_course', 'select[name*="course"]', 'select:nth-of-type(3)'];

    // courses to check (fuzzy match allowed)
    const coursesToCheck = [
      'Advanced (ICITSS) MCS Course',
      'AICITSS-Advanced Information Technology'
    ];

    const allPositives = []; // { courseName, batch, seats }

    // Pre-select region and POU each loop (safer)
    for (const courseName of coursesToCheck) {
      console.log('--- Checking course:', courseName);
      // select Region
      const gotRegion = await findAndSelect(regionSelectors, 'Southern');
      if (gotRegion) await sleep(1000);

      // select POU
      const gotPou = await findAndSelect(pouSelectors, 'HYDERABAD');
      if (gotPou) await sleep(1000);

      // select Course
      const gotCourse = await findAndSelect(courseSelectors, courseName);
      if (!gotCourse) {
        console.warn(`Could not explicitly select course matching "${courseName}". Will still attempt to Get List.`);
      }
      await sleep(800);

      // click Get List
      await clickGetList();
      await sleep(2200);

      // ensure table present
      const tableHandle = await page.$('table');
      if (!tableHandle) {
        // dump small snippet for debugging then continue to next course
        const html = await page.content();
        console.error(`No table found after clicking Get List for course "${courseName}". Page snippet:`);
        console.error(html.slice(0,8000));
        continue;
      }

      // parse rows
      const rows = await parseTable();

      // find positives
      for (const r of rows) {
        const val = r.seats ? r.seats.replace(/\D/g,'') : '';
        if (val !== '' && parseInt(val,10) > 0) {
          allPositives.push({ course: courseName, batch: r.batch, seats: r.seats, raw: r.raw });
        }
      }

      // small pause before next course to allow UI to stabilise
      await sleep(800);
    }

    await browser.close();

    if (allPositives.length > 0) {
      // Compose message grouped by course
      const grouped = {};
      for (const p of allPositives) {
        grouped[p.course] = grouped[p.course] || [];
        grouped[p.course].push(`${p.batch} → ${p.seats}`);
      }
      let msgParts = [`ICAI seats available!`];
      for (const [course, items] of Object.entries(grouped)) {
        msgParts.push(`\n${course}:\n${items.join('\n')}`);
      }
      msgParts.push(`\n${targetURL}`);
      const msg = msgParts.join('\n');

      // Telegram notify with debug logging
      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        try {
          const res = await fetch(tgUrl, {
            method: 'POST',
            headers: {'content-type':'application/json'},
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
          });
          const text = await res.text();
          console.log('Telegram HTTP status:', res.status);
          console.log('Telegram response body:', text);
        } catch (e) {
          console.error('Telegram request failed:', e);
        }
      } else {
        console.warn('Telegram token or chat id missing — not sending Telegram message.');
      }

      // Email notify via SMTP if provided
      if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && EMAIL_TO) {
        try {
          const transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: Number(SMTP_PORT),
            secure: Number(SMTP_PORT) === 465,
            auth: { user: SMTP_USER, pass: SMTP_PASS }
          });
          await transporter.sendMail({ from: SMTP_USER, to: EMAIL_TO, subject: 'ICAI seats available!', text: msg });
          console.log('Email sent to', EMAIL_TO);
        } catch (e) {
          console.error('Email send failed:', e);
        }
      }

      console.log('ALERT: seats available!', allPositives);
      process.exit(0);
    } else {
      console.log('No seats currently available for checked courses.');
      process.exit(0);
    }

  } catch (err) {
    console.error('Script error:', err);
    try { await browser.close(); } catch(e){}
    process.exit(2);
  }
})();
