// check_icai.js — Final Resilient Dual-Course Version (Crash Fix)
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');

// Utility function to pause execution
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  // 1. Load Secrets
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  const SMTP_HOST = process.env.SMTP_HOST;
  const SMTP_PORT = process.env.SMTP_PORT;
  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASS = process.env.SMTP_PASS;
  const EMAIL_TO = process.env.EMAIL_TO;

  const targetURL = 'https://www.icaionlineregistration.org/launchbatchdetail.aspx';
  
  // 2. Configuration
  const REGION_TEXT = 'Southern';
  const POU_TEXT = 'HYDERABAD';
  const COURSES_TO_CHECK = [
    'Advanced (ICITSS) MCS',
    'AICITSS-Advanced Information Technology'
  ];

  let allFoundSeats = []; // Store results: { course, batch, seats }
  let serverDataTimestamp = 'Unknown'; // To track server time

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // --- HELPER: Select Option by Text (SAFE VERSION) ---
  async function selectOptionByText(selectHandle, text) {
    if (!selectHandle) return false;
    const opts = await selectHandle.$$eval('option', options => options.map(o => ({ value: o.value, text: o.innerText.trim() })));
    const match = opts.find(o => o.text.toLowerCase().includes(text.toLowerCase()));
    if (match) {
      // Just select the option. Playwright handles the events.
      // Removing the manual 'dispatchEvent' because it causes crashes on auto-reloading pages.
      await selectHandle.selectOption(match.value);
      return true;
    }
    return false;
  }

  // --- HELPER: Find Element and Select ---
  async function findAndSelect(possibleSelectors, visibleText) {
    for (const sel of possibleSelectors) {
      try {
        const handle = await page.$(sel);
        if (!handle) continue;
        const ok = await selectOptionByText(handle, visibleText);
        if (ok) {
          console.log(`Selected "${visibleText}" using selector ${sel}`);
          return true;
        }
      } catch (e) { /* continue */ }
    }
    return false;
  }

  try {
    console.log('Navigating to target page...');
    await page.goto(targetURL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000); // Initial load wait

    // --- PHASE 1: ROBUST REGION & POU SELECTION ---
    console.log(`Attempting to select Region: ${REGION_TEXT}...`);
    
    // 1. Select Region
    const regionHandle = await page.$('#ddl_reg');
    if (!regionHandle) throw new Error('Could not find Region dropdown (#ddl_reg)');
    
    const regionSelected = await selectOptionByText(regionHandle, REGION_TEXT);
    if (!regionSelected) throw new Error(`Failed to select Region: ${REGION_TEXT}`);
    
    // CRITICAL FIX: Wait for the page reload (postback) that happens after selecting Region
    console.log('Region selected. Waiting for page reload...');
    try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch(e) {
        console.log('Page reload wait timed out (might have been quick). Continuing...');
    }
    await sleep(2000); // Extra safety buffer

    // 2. Select POU
    console.log(`Attempting to select POU: ${POU_TEXT}...`);
    // Re-fetch the element because the page reloaded! The old handle is dead.
    const pouHandle = await page.$('#ddl_pou');
    if (!pouHandle) throw new Error('POU dropdown missing after region selection');

    const pouSelected = await selectOptionByText(pouHandle, POU_TEXT);
    
    if (!pouSelected) {
      console.warn(`First POU selection failed. Retrying...`);
      await sleep(2000);
      const retryPou = await selectOptionByText(pouHandle, POU_TEXT);
      if (!retryPou) throw new Error(`Failed to select POU: ${POU_TEXT}`);
    }
    console.log('Region and POU successfully configured.');


    // --- PHASE 2: CHECK EACH COURSE ---
    const courseSelectors = ['#ddl_course', 'select[name*="course"]', 'select:nth-of-type(3)'];

    for (const courseName of COURSES_TO_CHECK) {
      console.log(`\n--- Checking Course: ${courseName} ---`);

      // A. Select Course
      const gotCourse = await findAndSelect(courseSelectors, courseName);
      if (!gotCourse) {
        console.warn(`Skipping ${courseName}: Could not select option in dropdown.`);
        continue;
      }
      await sleep(1500);

      // B. Setup Response Listener
      const responsePromise = page.waitForResponse(resp => 
        resp.url().toLowerCase().includes('launchbatchdetail.aspx') && resp.status() === 200
      ).catch(() => null);

      // C. Click "Get List"
      let clicked = false;
      const btnXPaths = [
        `//input[@type="button" and contains(@value,"Get List")]`,
        `//input[@type="submit" and contains(@value,"Get List")]`,
        `//a[contains(text(),"Get List")]`
      ];
      for (const xp of btnXPaths) {
        const el = await page.$(`xpath=${xp}`);
        if (el) { 
          try { 
            await el.click({ timeout: 5000 }); 
            clicked = true; 
            console.log('Clicked "Get List" button.');
            break; 
          } catch(e) {} 
        }
      }
      
      if (!clicked) {
        const fallback = await page.$('input[type="submit"], button');
        if (fallback) { await fallback.click(); clicked = true; }
      }

      await sleep(3000); // Wait for table to load

      // D. Capture Timestamp
      const response = await responsePromise;
      if (response && response.headers()['date']) {
        serverDataTimestamp = response.headers()['date'];
      }

      // E. Find Table
      let tableHandle = await page.$('table');
      if (!tableHandle) {
        tableHandle = await page.waitForSelector('table', { timeout: 5000 }).catch(()=>null);
      }

      if (!tableHandle) {
        console.log(`No results table found for ${courseName}.`);
        continue;
      }

      // F. Parse Table for "Available Seats"
      const seatResults = await page.evaluate(() => {
        const tbl = document.querySelector('table');
        if (!tbl) return [];
        
        const headerRow = Array.from(tbl.querySelectorAll('tr')).find(r => Array.from(r.cells).some(c => /Available\s*Seats/i.test(c.innerText)));
        if (!headerRow) return [];
        
        const headers = Array.from(headerRow.cells).map(c => c.innerText.trim());
        const colIndex = headers.findIndex(c => /Available\s*Seats/i.test(c));
        if (colIndex === -1) return [];

        const dataRows = Array.from(tbl.querySelectorAll('tr')).slice(1);
        return dataRows.map(row => {
          const cells = Array.from(row.cells).map(c => c.innerText.trim());
          let seats = cells[colIndex];
          if (!seats || seats === '') {
             seats = cells.find(c => /^\d+$/.test(c)) || '0';
          }
          return { batch: cells[0], seats: seats };
        });
      });

      // G. Filter Positive Seats
      const positive = seatResults.filter(r => {
        const val = r.seats ? r.seats.replace(/\D/g,'') : '0';
        return parseInt(val, 10) > 0;
      });

      if (positive.length > 0) {
        console.log(`FOUND SEATS for ${courseName}!`);
        positive.forEach(p => allFoundSeats.push({ course: courseName, batch: p.batch, seats: p.seats }));
      } else {
        console.log(`No available seats found for ${courseName}.`);
      }
      
      await sleep(1000);
    } // End Loop

    await browser.close();

    // --- PHASE 3: NOTIFICATIONS ---
    if (allFoundSeats.length > 0) {
      const timeMsg = `ICAI Data Timestamp: ${serverDataTimestamp}`;
      const header = `🚨 ICAI SEATS AVAILABLE! (${allFoundSeats.length} batches)`;
      const details = allFoundSeats.map(p => `• ${p.course}\n   Batch: ${p.batch} -> ${p.seats} Seats`).join('\n\n');
      const msg = `${header}\n${timeMsg}\n\n${details}\n\nLink: ${targetURL}`;

      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await fetch(tgUrl, {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
        });
      }

      if (SMTP_HOST && EMAIL_TO) {
        const transporter = nodemailer.createTransport({
          host: SMTP_HOST,
          port: Number(SMTP_PORT),
          secure: Number(SMTP_PORT) === 465,
          auth: { user: SMTP_USER, pass: SMTP_PASS }
        });
        await transporter.sendMail({ from: SMTP_USER, to: EMAIL_TO, subject: 'ICAI SEATS ALERT', text: msg });
      }

      console.log('Final Alert Sent!');
      process.exit(0);
    } else {
      console.log(`Check complete. No seats found. (Server Time: ${serverDataTimestamp})`);
      process.exit(0);
    }

  } catch (err) {
    console.error('Critical Script Error:', err);
    try { await browser.close(); } catch(e){}
    process.exit(1);
  }
})();
