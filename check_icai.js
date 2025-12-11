// check_icai.js — FINAL DUAL COURSE MONITORING VERSION
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');

// Utility function to pause execution
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
  const REGION = 'Southern';
  const POU = 'HYDERABAD';
  
  // --- LIST OF COURSES TO CHECK ---
  const COURSES_TO_CHECK = [
    'Advanced (ICITSS) MCS',
    'AICITSS-Advanced Information Technology'
  ];
  
  let allFoundSeats = []; // Array to store results from all courses

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
  // --- END OF HELPER FUNCTIONS ---


  try {
    console.log('Navigating to target page...');
    await page.goto(targetURL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000); // initial wait

    // --- PHASE 1: SELECT REGION AND POU (Common for both courses) ---
    const regionSelectors = ['#ddl_reg', 'select[name*="region"]', 'select:nth-of-type(1)'];
    const pouSelectors = ['#ddl_pou', 'select[name*="pou"]', 'select:nth-of-type(2)'];
    const courseSelectors = ['#ddl_course', 'select[name*="course"]', 'select:nth-of-type(3)'];

    let gotRegion = await findAndSelect(regionSelectors, REGION);
    if (gotRegion) await sleep(1500);

    let gotPou = await findAndSelect(pouSelectors, POU);
    if (gotPou) await sleep(1500);

    if (!gotRegion || !gotPou) {
      throw new Error(`Failed to select mandatory criteria: Region (${REGION}) or POU (${POU}).`);
    }
    console.log('Region and POU successfully selected.');

    // --- PHASE 2: LOOP THROUGH EACH COURSE AND CHECK SEATS ---
    for (const courseName of COURSES_TO_CHECK) {
      console.log(`\n--- Checking Course: ${courseName} ---`);
      
      // 1. Select the current Course
      // We use the page handle, so the first two selections (Region/POU) are maintained
      let gotCourse = await findAndSelect(courseSelectors, courseName);
      if (!gotCourse) {
        console.warn(`Skipping ${courseName}: Failed to select option.`);
        continue;
      }
      await sleep(1500); // Wait for page to react to course selection

      // 2. Click "Get List" button 
      let clicked = false;
      const btnXPaths = [
        `//input[@type="button" and contains(@value,"Get List")]`,
        `//button[contains(text(),"Get List")]`
      ];
      for (const xp of btnXPaths) {
        const el = await page.$(`xpath=${xp}`);
        if (el) { try { await el.click({ timeout: 5000 }); clicked = true; break; } catch(e){ } }
      }
      await sleep(3000); // Wait for results to load

      // 3. Find table and parse seats
      let tableHandle = await page.waitForSelector('table', { timeout: 8000 }).catch(()=>null);
          
      if (!tableHandle) {
        console.log(`No table found for ${courseName}. Assumed no seats.`);
        continue;
      }

      // Determine column index
      const colIndex = await page.evaluate(() => {
        const tbl = document.querySelector('table');
        const headerRow = Array.from(tbl.querySelectorAll('tr')).find(r => Array.from(r.cells).some(c => /Available\\s*Seats/i.test(c.innerText)));
        if (!headerRow) return -1;
        const cells = Array.from(headerRow.cells).map(c => c.innerText.trim());
        return cells.findIndex(c => /Available\\s*Seats/i.test(c));
      });
      
      // Extract seat information
      const seatInfo = await page.evaluate((colIndex) => {
        const tbl = document.querySelector('table');
        const rows = Array.from(tbl.querySelectorAll('tr')).slice(1);
        const results = [];
        rows.forEach(row => {
          const cells = Array.from(row.cells).map(c => c.innerText.trim());
          let batch = cells[0] || '';
          let seats = colIndex >= 0 && cells[colIndex] ? cells[colIndex] : null;
          if (seats === null || seats === '') {
            for (const c of cells) { if (/^\\d+$/.test(c)) { seats = c; break; } }
          }
          results.push({ batch, seats });
        });
        return results;
      }, colIndex);

      // 4. Check for positive seat numbers
      const positive = seatInfo.filter(r => {
        const val = r.seats ? r.seats.replace(/\\D/g,'') : '';
        return val !== '' && parseInt(val,10) > 0;
      });

      if (positive.length > 0) {
        console.log(`ALERT: Found ${positive.length} batches with seats for ${courseName}.`);
        positive.forEach(p => allFoundSeats.push({ course: courseName, batch: p.batch, seats: p.seats }));
      } else {
        console.log(`No seats found for ${courseName}.`);
      }
    } // End of Course Loop

    await browser.close();

    // --- PHASE 3: CONSOLIDATED ALERTING ---
    if (allFoundSeats.length > 0) {
      const header = `ICAI seats available! Total batches found: ${allFoundSeats.length}.`;
      // Format: Course Name -> Batch -> Seats
      const details = allFoundSeats.map(p => 
        `${p.course} → ${p.batch} → ${p.seats}`
      ).join('\\n');
      
      const msg = `${header}\\n${details}\\n${targetURL}`;

      // Telegram notify
      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await fetch(tgUrl, {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
        });
      }

      // Email notify (if configured)
      if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && EMAIL_TO) {
        const transporter = nodemailer.createTransport({
          host: SMTP_HOST,
          port: Number(SMTP_PORT),
          secure: Number(SMTP_PORT) === 465,
          auth: { user: SMTP_USER, pass: SMTP_PASS }
        });
        await transporter.sendMail({ from: SMTP_USER, to: EMAIL_TO, subject: 'ICAI seats available!', text: msg });
      }
      console.log('FINAL ALERT: Seats found across checked courses!');
      process.exit(0);
    } else {
      console.log('No seats currently available across any checked courses.');
      process.exit(0);
    }

  } catch (err) {
    console.error('Script error:', err);
    try { await browser.close(); } catch(e){}
    process.exit(2);
  }
})();
