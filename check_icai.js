// check_icai_multi_course_all_batches.js
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

  const targetURL = 'https://www.icaionlineregistration.org/LaunchBatchDetail.aspx';

  // Courses to check — fuzzy matches allowed
  const coursesToCheck = [
    'Advanced (ICITSS) MCS Course',
    'Advanced Information Technology'
  ];

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
      // wait a bit for options to populate (AJAX / client population)
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

    // REGION & POU selectors (try a few possibilities)
    const regionSelectors = ['#ddl_reg', 'select[name*="region"]', 'select:nth-of-type(1)'];
    const pouSelectors = ['#ddl_pou', 'select[name*="pou"]', 'select:nth-of-type(2)'];
    const courseSelectors = ['#ddl_course', 'select[name*="course"]', 'select:nth-of-type(3)'];

    // Select Region once
    const gotRegion = await findAndSelect(regionSelectors, 'Southern');
    if (gotRegion) await sleep(1500);

    // Select POU once
    const gotPou = await findAndSelect(pouSelectors, 'HYDERABAD');
    if (gotPou) await sleep(1500);

    if (!gotRegion || !gotPou) {
      console.warn('Region or POU selection may have failed; script will continue but results may be incorrect.');
    }

    // function to click "Get List" robustly
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
        if (el) {
          try { await el.click({ timeout: 5000 }); console.log('Clicked Get List via xpath', xp); return true; } catch(e){ console.warn('click failed', xp, e.message); }
        }
      }
      const btnFallback = await page.$('input[type="button"], button, a');
      if (btnFallback) { try { await btnFallback.click(); console.log('Clicked first button fallback'); return true; } catch(e) { console.warn('fallback click failed', e.message); } }
      console.warn('Could not find a Get List button to click.');
      return false;
    }

    // collect results across courses
    const aggregatedResults = []; // { course, batch, seats }

    // iterate courses
    for (const courseName of coursesToCheck) {
      console.log('Checking course:', courseName);

      // Select the course
      const gotCourse = await findAndSelect(courseSelectors, courseName);
      if (!gotCourse) {
        console.warn(`Could not select course "${courseName}". Still attempting to click Get List and parse.`);
      }

      // Click Get List and wait a short while
      await clickGetList();
      await sleep(2500);

      // locate table (similar logic as before)
      const possibleTableSelectors = [
        'table', 
        '#ctl00_ContentPlaceHolder1_gvBatch',
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
      if (!tableHandle) {
        // wait briefly for any table to appear
        tableHandle = await page.waitForSelector('table', { timeout: 5000 }).catch(()=>null);
        if (tableHandle) console.log('Found table by waiting for generic table selector.');
      }

      if (!tableHandle) {
        // Dump short HTML snippet for debugging and continue to next course
        const html = await page.content();
        const snippet = html.slice(0, 20000);
        console.error(`No table found for course "${courseName}". Page HTML snippet (first 20k chars):`);
        console.error(snippet);
        continue;
      }

      // find available seats column index
      const colIndex = await page.evaluate(() => {
        const tbl = document.querySelector('table');
        if (!tbl) return -1;
        const headerRow = Array.from(tbl.querySelectorAll('tr')).find(r => Array.from(r.cells).some(c => /Available\s*Seats/i.test(c.innerText)));
        if (!headerRow) return -1;
        const cells = Array.from(headerRow.cells).map(c => c.innerText.trim());
        const idx = cells.findIndex(c => /Available\s*Seats/i.test(c));
        return idx;
      });

      // parse rows for this course
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
              if (/^\d+$/.test(c)) { seats = c; break; }
            }
          }
          results.push({ batch, seats });
        });
        return results;
      }, colIndex);

      // --- CHANGED LOGIC HERE ---
      // Removed the filter that required seats > 0.
      // Now checking if batch name exists, so we get ALL batches.
      const positiveForCourse = seatInfo
        .map(r => ({ course: courseName, batch: r.batch, seats: r.seats }))
        .filter(r => r.batch && r.batch.trim().length > 0);

      console.log(`Found ${positiveForCourse.length} total rows for "${courseName}".`);
      aggregatedResults.push(...positiveForCourse);

      // small delay before next course iteration
      await sleep(1000);
    } // end courses loop

    await browser.close();

    // Changed condition: Report if ANY results found (even if seats are 0)
    if (aggregatedResults.length > 0) {
      // build message grouped by course
      const grouped = aggregatedResults.reduce((acc, cur) => {
        acc[cur.course] = acc[cur.course] || [];
        acc[cur.course].push(`${cur.batch} → ${cur.seats}`);
        return acc;
      }, {});
      let msgLines = ['ICAI Batch Status Update:'];
      for (const [course, rows] of Object.entries(grouped)) {
        msgLines.push(`\n${course}:`);
        rows.forEach(r => msgLines.push(` - ${r}`));
      }
      msgLines.push(`\n${targetURL}`);
      const msg = msgLines.join('\n');

      // Telegram notify (with debug)
      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        try {
          const res = await fetch(tgUrl, {
            method: 'POST',
            headers: {'content-type':'application/json'},
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
          });
          const body = await res.text();
          console.log('Telegram HTTP status:', res.status);
          console.log('Telegram response body:', body);
        } catch (e) {
          console.error('Telegram request failed:', e);
        }
      } else {
        console.warn('Telegram env vars missing; not sending Telegram message.');
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
          await transporter.sendMail({ from: SMTP_USER, to: EMAIL_TO, subject: 'ICAI Batch Status', text: msg });
          console.log('Email sent to', EMAIL_TO);
        } catch (e) {
          console.error('Email sending failed:', e);
        }
      }

      console.log('ALERT: Batches found (sending notification)!', aggregatedResults);
      process.exit(0);
    } else {
      console.log('No batches found in the table for either course.');
      process.exit(0);
    }

  } catch (err) {
    console.error('Script error:', err);
    try { await browser.close(); } catch(e){}
    process.exit(2);
  }
})();
