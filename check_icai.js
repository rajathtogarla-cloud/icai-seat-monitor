// check_icai_debug_selects.js — improved selection + diagnostic logging
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

  // helper: choose an option by visible text (fuzzy) using an ElementHandle
  async function selectOptionOnHandle(handle, text) {
    if (!handle) return false;
    try {
      const opts = await handle.$$eval('option', options => options.map(o => ({ value: o.value, text: o.innerText.trim() })));
      const match = opts.find(o => o.text.toLowerCase().includes(text.toLowerCase()));
      if (match) {
        await handle.selectOption(match.value);
        await handle.evaluate((el) => {
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return true;
      }
    } catch (e) {
      // ignore
    }
    return false;
  }

  // new helper: scan all selects, print their options, and try to select target by scanning
  async function debugAndSelectFromAllSelects(targetText, label) {
    console.log(`--- Scanning all <select> elements to find "${targetText}" (${label}) ---`);
    const all = await page.$$('select');
    if (all.length === 0) {
      console.warn('No <select> elements found on the page at all.');
      return false;
    }
    for (let i = 0; i < all.length; ++i) {
      const handle = all[i];
      // get option texts (first N chars)
      const opts = await handle.$$eval('option', options => options.map(o => o.innerText.trim()));
      console.log(`select[#${i}] options (first 200 chars combined): ${opts.join(' | ').slice(0,200)}`);
    }
    // attempt to find & select
    for (let i = 0; i < all.length; ++i) {
      const handle = all[i];
      const ok = await selectOptionOnHandle(handle, targetText);
      if (ok) {
        console.log(`Selected "${targetText}" using select[#${i}] (scanned).`);
        return true;
      }
    }
    console.warn(`Did not find option matching "${targetText}" in any <select>.`);
    return false;
  }

  // fallback: try several known selectors then scan all selects
  async function findAndSelect(possibleSelectors, visibleText, labelForLogs='') {
    // try direct selectors first
    for (const sel of possibleSelectors) {
      try {
        const handle = await page.$(sel);
        if (!handle) continue;
        const ok = await selectOptionOnHandle(handle, visibleText);
        if (ok) {
          console.log(`Selected "${visibleText}" using selector ${sel}`);
          return true;
        } else {
          // log options for this selector for debugging
          const opts = await handle.$$eval('option', options => options.map(o => o.innerText.trim()));
          console.log(`Selector ${sel} exists but options do not match (first 200 chars): ${opts.join(' | ').slice(0,200)}`);
        }
      } catch (e) {
        console.warn(`Selector ${sel} caused error: ${e.message}`);
      }
    }
    // if direct selectors failed, scan all selects (and print them)
    const scanned = await debugAndSelectFromAllSelects(visibleText, labelForLogs || visibleText);
    return scanned;
  }

  try {
    console.log('Navigating to target page...');
    await page.goto(targetURL, { waitUntil: 'networkidle', timeout: 60000 });

    // initial wait to let page JS populate selects
    await sleep(3500);

    // REGION & POU selectors (try a few possibilities)
    const regionSelectors = ['#ddl_reg', 'select[name*="reg"]', 'select[name*="region"]', 'select:nth-of-type(1)'];
    const pouSelectors = ['#ddl_pou', 'select[name*="pou"]', 'select:nth-of-type(2)'];
    const courseSelectors = ['#ddl_course', 'select[name*="course"]', 'select:nth-of-type(3)'];

    // Try selecting Region
    const regionWanted = 'Southern';
    const gotRegion = await findAndSelect(regionSelectors, regionWanted, 'Region');
    if (gotRegion) {
      await sleep(1600);
    } else {
      console.warn(`Failed to select "${regionWanted}". See select listings above for details.`);
    }

    // Try selecting POU
    const pouWanted = 'HYDERABAD';
    const gotPou = await findAndSelect(pouSelectors, pouWanted, 'POU');
    if (gotPou) await sleep(1500);
    else console.warn(`Failed to select POU "${pouWanted}".`);

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
      const gotCourse = await findAndSelect(courseSelectors, courseName, 'Course');
      if (!gotCourse) {
        console.warn(`Could not select course "${courseName}". Still attempting to click Get List and parse.`);
      }
      await sleep(800);

      // Click Get List and wait a short while
      await clickGetList();
      await sleep(2200);

      // locate table
      let tableHandle = await page.$('table');
      if (!tableHandle) tableHandle = await page.waitForSelector('table', { timeout: 6000 }).catch(()=>null);
      if (!tableHandle) {
        const html = await page.content();
        console.error(`No table found for course "${courseName}". HTML snippet (first 20k chars):`);
        console.error(html.slice(0,20000));
        continue;
      } else {
        console.log('Found table for course:', courseName);
      }

      // find available seats column index
      const colIndex = await page.evaluate(() => {
        const tbl = document.querySelector('table');
        if (!tbl) return -1;
        const headerRow = Array.from(tbl.querySelectorAll('tr')).find(r => Array.from(r.cells).some(c => /Available\\s*Seats/i.test(c.innerText)));
        if (!headerRow) return -1;
        const cells = Array.from(headerRow.cells).map(c => c.innerText.trim());
        const idx = cells.findIndex(c => /Available\\s*Seats/i.test(c));
        return idx;
      });

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

      const positiveForCourse = seatInfo
        .map(r => ({ course: courseName, batch: r.batch, seats: r.seats }))
        .filter(r => {
          const v = r.seats ? r.seats.replace(/\\D/g,'') : '';
          return v !== '' && parseInt(v,10) > 0;
        });

      console.log(`Found ${positiveForCourse.length} positive rows for "${courseName}".`);
      aggregatedResults.push(...positiveForCourse);

      await sleep(900);
    } // end courses loop

    await browser.close();

    if (aggregatedResults.length > 0) {
      const grouped = aggregatedResults.reduce((acc, cur) => {
        acc[cur.course] = acc[cur.course] || [];
        acc[cur.course].push(`${cur.batch} → ${cur.seats}`);
        return acc;
      }, {});
      let msgLines = ['ICAI seats available!'];
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
          console.error('Email sending failed:', e);
        }
      }

      console.log('ALERT: seats available!', aggregatedResults);
      process.exit(0);
    } else {
      console.log('No seats currently available for either course.');
      process.exit(0);
    }

  } catch (err) {
    console.error('Script error:', err);
    try { await browser.close(); } catch(e){}
    process.exit(2);
  }
})();
