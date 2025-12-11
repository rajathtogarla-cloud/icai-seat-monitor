// check_icai_multi_course_force_select.js — resilient selection + multi-course checks
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

  // improved: try normal select, then fallback to forcing selection via evaluate()
  async function trySelectOnHandle(handle, wantedText) {
    if (!handle) return false;
    // get options
    const opts = await handle.$$eval('option', options => options.map(o => ({ value: o.value, text: o.innerText.trim() })));
    // try fuzzy match (includes)
    let match = opts.find(o => o.text.toLowerCase().includes(wantedText.toLowerCase()));
    if (!match) {
      // try exact trimmed match
      match = opts.find(o => o.text.trim().toLowerCase() === wantedText.trim().toLowerCase());
    }
    if (!match) return false;

    // First try the normal Playwright selectOption
    try {
      await handle.selectOption(match.value);
      // dispatch events
      await handle.evaluate((el) => {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      console.log(`Normal selectOption succeeded for value="${match.value}" text="${match.text}"`);
      return true;
    } catch (e) {
      console.warn('Normal selectOption failed, will force via evaluate():', e.message);
    }

    // Fallback: force selection via evaluate (works even if selectOption fails)
    try {
      await handle.evaluate((el, want) => {
        // find matching option index by comparing trimmed text (case-insensitive)
        let idx = -1;
        for (let i = 0; i < el.options.length; i++) {
          const t = (el.options[i].innerText || '').trim().toLowerCase();
          if (t === want.trim().toLowerCase() || t.includes(want.trim().toLowerCase())) {
            idx = i;
            break;
          }
        }
        if (idx === -1) {
          // as a last resort, try matching by value if the want looks like a value
          for (let i = 0; i < el.options.length; i++) {
            if (el.options[i].value === want) { idx = i; break; }
          }
        }
        if (idx !== -1) {
          el.selectedIndex = idx;
          el.value = el.options[idx].value;
        }
        // dispatch events so client JS notices
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, match.text);
      console.log(`Forced selection via evaluate() to option text="${match.text}", value="${match.value}"`);
      return true;
    } catch (e) {
      console.error('Force-select evaluate() failed:', e.message);
      return false;
    }
  }

  // scan all selects, print options, and attempt to select target
  async function scanAndSelect(wantedText, label) {
    console.log(`--- scanAndSelect: looking for "${wantedText}" (${label}) ---`);
    const all = await page.$$('select');
    if (!all || all.length === 0) {
      console.warn('No select elements found on page.');
      return false;
    }
    // print summary of each select's option texts (first 200 chars)
    for (let i = 0; i < all.length; ++i) {
      const opts = await all[i].$$eval('option', options => options.map(o => (o.innerText || '').trim()));
      console.log(`select[#${i}] options (summary): ${opts.join(' | ').slice(0,200)}`);
    }
    // try to pick the best select where the wanted text exists
    for (let i = 0; i < all.length; ++i) {
      const ok = await trySelectOnHandle(all[i], wantedText);
      if (ok) {
        console.log(`Selected "${wantedText}" using select[#${i}]`);
        return true;
      }
    }
    console.warn(`Could not find "${wantedText}" in any <select>.`);
    return false;
  }

  // generic find-and-select with selector hints then scan fallback
  async function findAndSelect(possibleSelectors, wantedText, label='') {
    for (const sel of possibleSelectors) {
      try {
        const handle = await page.$(sel);
        if (!handle) continue;
        const ok = await trySelectOnHandle(handle, wantedText);
        if (ok) {
          console.log(`Selected "${wantedText}" using selector ${sel}`);
          return true;
        } else {
          const opts = await handle.$$eval('option', options => options.map(o => (o.innerText||'').trim()));
          console.log(`Selector ${sel} exists but options: ${opts.join(' | ').slice(0,200)}`);
        }
      } catch (e) {
        console.warn(`Selector ${sel} caused error: ${e.message}`);
      }
    }
    // fallback: scan all selects and force select
    return await scanAndSelect(wantedText, label || wantedText);
  }

  try {
    console.log('Navigating to target page...');
    await page.goto(targetURL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000);

    const regionSelectors = ['#ddl_reg', 'select[name*="reg"]', 'select[name*="region"]', 'select:nth-of-type(1)'];
    const pouSelectors = ['#ddl_pou', 'select[name*="pou"]', 'select:nth-of-type(2)'];
    const courseSelectors = ['#ddl_course', 'select[name*="course"]', 'select:nth-of-type(3)'];

    const regionWanted = 'Southern';
    const pouWanted = 'HYDERABAD';

    const gotRegion = await findAndSelect(regionSelectors, regionWanted, 'Region');
    if (gotRegion) await sleep(1200);
    else console.warn(`Failed to select Region "${regionWanted}".`);

    const gotPou = await findAndSelect(pouSelectors, pouWanted, 'POU');
    if (gotPou) await sleep(1200);
    else console.warn(`Failed to select POU "${pouWanted}".`);

    if (!gotRegion || !gotPou) console.warn('Region or POU may be incorrect; continuing anyway.');

    // click Get List helper
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

    const aggregatedResults = [];

    for (const courseName of coursesToCheck) {
      console.log('Checking course:', courseName);
      const gotCourse = await findAndSelect(courseSelectors, courseName, 'Course');
      if (!gotCourse) console.warn(`Could not select course "${courseName}"`);

      await sleep(700);
      await clickGetList();
      await sleep(2000);

      // find table
      let tableHandle = await page.$('table');
      if (!tableHandle) tableHandle = await page.waitForSelector('table', { timeout: 6000 }).catch(()=>null);
      if (!tableHandle) {
        const html = await page.content();
        console.error(`No table found for course "${courseName}". HTML snippet:`);
        console.error(html.slice(0,20000));
        continue;
      }
      console.log('Found table for course:', courseName);

      const colIndex = await page.evaluate(() => {
        const tbl = document.querySelector('table');
        if (!tbl) return -1;
        const headerRow = Array.from(tbl.querySelectorAll('tr')).find(r => Array.from(r.cells).some(c => /Available\\s*Seats/i.test(c.innerText)));
        if (!headerRow) return -1;
        const cells = Array.from(headerRow.cells).map(c => c.innerText.trim());
        return cells.findIndex(c => /Available\\s*Seats/i.test(c));
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

      const positiveForCourse = seatInfo.map(r => ({ course: courseName, batch: r.batch, seats: r.seats }))
        .filter(r => {
          const v = r.seats ? r.seats.replace(/\\D/g,'') : '';
          return v !== '' && parseInt(v,10) > 0;
        });

      console.log(`Found ${positiveForCourse.length} positive rows for "${courseName}".`);
      aggregatedResults.push(...positiveForCourse);
      await sleep(900);
    }

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
