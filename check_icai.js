// check_icai.js — robust selection (avoids stale ElementHandle) + multi-course checks
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

  // Get list of all <select> options (returns array of arrays of texts)
  async function getSelectsSnapshot() {
    return await page.$$eval('select', selects =>
      selects.map(s => Array.from(s.options).map(o => (o.innerText||'').trim()))
    );
  }

  // Find a select index and option value by scanning option texts (string includes)
  // Returns {index, value, text} or null
  async function findSelectIndexValue(wantedText) {
    const selectsInfo = await page.$$eval('select', selects =>
      selects.map(s => Array.from(s.options).map(o => ({ value: o.value, text: (o.innerText||'').trim() })))
    );
    const lowWanted = wantedText.trim().toLowerCase();
    for (let i = 0; i < selectsInfo.length; ++i) {
      const opts = selectsInfo[i];
      // try fuzzy includes
      let match = opts.find(o => o.text.toLowerCase().includes(lowWanted));
      if (!match) {
        // try exact
        match = opts.find(o => o.text.trim().toLowerCase() === lowWanted);
      }
      if (match) return { index: i, value: match.value, text: match.text };
    }
    return null;
  }

  // Try to select a value by selector string "select:nth-of-type(N+1)" or by the given selector hint
  // This function avoids storing ElementHandles across navigation.
  async function selectByHintsOrScan(hints, wantedText, label = '') {
    // Try explicit hints (selector strings) first
    for (const hint of hints) {
      try {
        // Check if hint exists and contains option we want
        const exists = await page.$(hint);
        if (!exists) continue;
        // get options text for this selector
        const opts = await page.$$eval(`${hint} option`, options => options.map(o => ({ value: o.value, text: (o.innerText||'').trim() })));
        const lowWanted = wantedText.trim().toLowerCase();
        let match = opts.find(o => o.text.toLowerCase().includes(lowWanted)) || opts.find(o => o.text.trim().toLowerCase() === lowWanted);
        if (match) {
          // Use page.selectOption by selector string (safer)
          try {
            await page.selectOption(hint, match.value);
            // dispatch change/input so client scripts react
            await page.$eval(hint, el => { el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); });
            console.log(`Selected "${wantedText}" using hint selector ${hint} -> option "${match.text}"`);
            // allow dependent selects to populate
            await sleep(900);
            return true;
          } catch (e) {
            console.warn(`selectOption on ${hint} threw (will continue): ${e.message}`);
            // If this caused navigation, wait briefly and continue to scanning fallback
            await sleep(800);
          }
        } else {
          console.log(`Hint ${hint} exists but does not contain "${wantedText}"`);
        }
      } catch (e) {
        console.warn(`Hint selector ${hint} error: ${e.message}`);
      }
    }

    // Fallback: scan all selects and pick the first where the wanted option exists
    const found = await findSelectIndexValue(wantedText);
    if (!found) {
      console.warn(`Could not find option matching "${wantedText}" in any select.`);
      // Log snapshot to help debugging
      const snap = await getSelectsSnapshot();
      snap.forEach((opts, i) => console.log(`select[#${i}] sample options: ${opts.slice(0,20).join(' | ').slice(0,300)}`));
      return false;
    }

    // Compose nth-of-type selector (1-based)
    const nthSelector = `select:nth-of-type(${found.index + 1})`;
    try {
      await page.selectOption(nthSelector, found.value);
      await page.$eval(nthSelector, el => { el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); });
      console.log(`Selected "${wantedText}" by scanning -> select[#${found.index}] option "${found.text}"`);
      await sleep(900);
      return true;
    } catch (e) {
      console.warn(`Selecting by nth-of-type failed: ${e.message}. Waiting and retrying once...`);
      // Wait for potential navigation to finish then retry once
      await page.waitForLoadState('networkidle').catch(()=>null);
      try {
        await page.selectOption(nthSelector, found.value);
        await page.$eval(nthSelector, el => { el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); });
        console.log(`Retry select succeeded for select[#${found.index}]`);
        await sleep(900);
        return true;
      } catch (e2) {
        console.error(`Retry also failed for select[#${found.index}]: ${e2.message}`);
        return false;
      }
    }
  }

  // robust click for Get List
  async function clickGetList() {
    const xps = [
      `//input[@type="button" and contains(@value,"Get List")]`,
      `//input[@type="button" and contains(@value,"GetList")]`,
      `//button[contains(text(),"Get List")]`,
      `//a[contains(text(),"Get List")]`,
      `//input[@type="submit" and contains(@value,"Get List")]`
    ];
    for (const xp of xps) {
      const el = await page.$(`xpath=${xp}`);
      if (el) {
        try { await el.click({ timeout: 5000 }); console.log('Clicked Get List via', xp); return true; } catch (e) { console.warn('click failed', xp, e.message); await sleep(600); }
      }
    }
    const fallback = await page.$('input[type="button"], button, a');
    if (fallback) {
      try { await fallback.click(); console.log('Clicked fallback button'); return true; } catch(e){ console.warn('fallback click failed', e.message); }
    }
    console.warn('Could not click Get List.');
    return false;
  }

  try {
    console.log('Navigating to target page...');
    await page.goto(targetURL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(1500);

    // selector hints
    const regionHints = ['#ddl_reg', 'select[name*="reg"]', 'select[name*="region"]', 'select:nth-of-type(1)'];
    const pouHints = ['#ddl_pou', 'select[name*="pou"]', 'select:nth-of-type(2)'];
    const courseHints = ['#ddl_course', 'select[name*="course"]', 'select:nth-of-type(3)'];

    // Strong select attempts (retrying a few times in case of intermediate navigation)
    let ok = false;
    for (let attempt=0; attempt<3 && !ok; ++attempt) {
      ok = await selectByHintsOrScan(regionHints, 'Southern', 'Region');
      if (!ok) {
        console.log('Region select attempt', attempt+1, 'failed — waiting then retrying');
        await page.waitForLoadState('networkidle').catch(()=>null);
        await sleep(1000 + attempt*500);
      }
    }
    if (!ok) console.warn('Failed to set Region to Southern after retries.');

    ok = false;
    for (let attempt=0; attempt<3 && !ok; ++attempt) {
      ok = await selectByHintsOrScan(pouHints, 'HYDERABAD', 'POU');
      if (!ok) {
        console.log('POU select attempt', attempt+1, 'failed — waiting then retrying');
        await page.waitForLoadState('networkidle').catch(()=>null);
        await sleep(800 + attempt*400);
      }
    }
    if (!ok) console.warn('Failed to set POU to HYDERABAD after retries.');

    // proceed to check each course
    const aggregatedResults = [];
    for (const courseName of coursesToCheck) {
      console.log('--- Checking course:', courseName, '---');

      // select course (retry)
      let okCourse = false;
      for (let attempt=0; attempt<3 && !okCourse; ++attempt) {
        okCourse = await selectByHintsOrScan(courseHints, courseName, 'Course');
        if (!okCourse) {
          await page.waitForLoadState('networkidle').catch(()=>null);
          await sleep(700 + attempt*300);
        }
      }
      if (!okCourse) console.warn(`Warning: could not select course "${courseName}".`);

      // click get list and wait
      await clickGetList();
      await sleep(2000);

      // find table
      let tableHandle = await page.$('table');
      if (!tableHandle) tableHandle = await page.waitForSelector('table', { timeout: 6000 }).catch(()=>null);
      if (!tableHandle) {
        console.error('No table found for course', courseName);
        const html = await page.content();
        console.error(html.slice(0,15000));
        continue;
      }

      // detect column index for Available Seats
      const colIndex = await page.evaluate(() => {
        const tbl = document.querySelector('table');
        if (!tbl) return -1;
        const headerRow = Array.from(tbl.querySelectorAll('tr')).find(r => Array.from(r.cells).some(c => /Available\\s*Seats/i.test(c.innerText)));
        if (!headerRow) return -1;
        const cells = Array.from(headerRow.cells).map(c => c.innerText.trim());
        return cells.findIndex(c => /Available\\s*Seats/i.test(c));
      });

      // parse rows
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

      const positive = seatInfo.map(r => ({ course: courseName, batch: r.batch, seats: r.seats }))
        .filter(r => {
          const v = r.seats ? r.seats.replace(/\\D/g,'') : '';
          return v !== '' && parseInt(v,10) > 0;
        });

      console.log(`Found ${positive.length} positive rows for "${courseName}"`);
      aggregatedResults.push(...positive);

      // tiny delay before next course
      await sleep(900);
    } // courses loop

    await browser.close();

    if (aggregatedResults.length > 0) {
      const grouped = aggregatedResults.reduce((acc, cur) => { acc[cur.course] = acc[cur.course] || []; acc[cur.course].push(`${cur.batch} → ${cur.seats}`); return acc; }, {});
      let msgLines = ['ICAI seats available!'];
      for (const [course, rows] of Object.entries(grouped)) {
        msgLines.push(`\n${course}:`);
        rows.forEach(r => msgLines.push(` - ${r}`));
      }
      msgLines.push(`\n${targetURL}`);
      const msg = msgLines.join('\n');

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
