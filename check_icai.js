// check_icai.js — Final Resilient Version (Fixes POU Timeout)
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
  
  const REGION_TEXT = 'Southern';
  const POU_TEXT = 'HYDERABAD';
  const COURSES_TO_CHECK = [
    'Advanced (ICITSS) MCS',
    'Advanced Information Technology'
  ];

  let allFoundSeats = [];
  let serverDataTimestamp = 'Unknown';

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Helper to select option and FORCE the change event
  async function forceSelectOption(selector, text) {
    const handle = await page.$(selector);
    if (!handle) return false;

    const opts = await handle.$$eval('option', options => options.map(o => ({ value: o.value, text: o.innerText.trim() })));
    const match = opts.find(o => o.text.toLowerCase().includes(text.toLowerCase()));
    
    if (match) {
      // 1. Select the value
      await handle.selectOption(match.value);
      
      // 2. FORCE the change event (Crucial for ASP.NET)
      await handle.evaluate(el => {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur')); // sometimes needed
      });
      return true;
    }
    return false;
  }

  try {
    console.log('Navigating to target page...');
    await page.goto(targetURL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000);

    // --- PHASE 1: ROBUST REGION SELECTION ---
    console.log(`Attempting to select Region: ${REGION_TEXT}...`);
    
    // Select Region and Force Event
    const regionSuccess = await forceSelectOption('#ddl_reg', REGION_TEXT);
    if (!regionSuccess) throw new Error(`Could not select Region: ${REGION_TEXT}`);
    
    console.log('Region selected. Waiting for POU update...');
    
    // Wait for the POU dropdown to refresh (ASP.NET postback)
    // We wait for the network to be idle, meaning the server sent the new data
    try {
        await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch(e) {
        console.log('Network idle wait timed out, proceeding check...');
    }
    await sleep(2000);

    // --- PHASE 2: POU SELECTION ---
    console.log(`Attempting to select POU: ${POU_TEXT}...`);
    
    // Ensure POU is visible and enabled
    try {
      await page.waitForSelector('#ddl_pou:not([disabled])', { state: 'visible', timeout: 10000 });
    } catch(e) {
      console.warn('POU dropdown did not become enabled. Region selection might have failed silently.');
    }

    const pouSuccess = await forceSelectOption('#ddl_pou', POU_TEXT);
    if (!pouSuccess) {
       console.warn(`Failed to select POU: ${POU_TEXT}. Will try checking courses anyway (results may be wrong).`);
    } else {
       console.log('Region and POU successfully configured.');
    }
    await sleep(2000);


    // --- PHASE 3: CHECK EACH COURSE ---
    const courseSelectors = ['#ddl_course', 'select[name*="course"]'];

    for (const courseName of COURSES_TO_CHECK) {
      console.log(`\n--- Checking Course: ${courseName} ---`);

      // Try finding course dropdown
      let courseHandle = await page.$('#ddl_course');
      if (!courseHandle) {
         // Fallback if ID changed
         courseHandle = await page.$('select[name*="course"]');
      }

      if (courseHandle) {
          // Select Course
          const opts = await courseHandle.$$eval('option', options => options.map(o => ({ value: o.value, text: o.innerText.trim() })));
          const match = opts.find(o => o.text.toLowerCase().includes(courseName.toLowerCase()));
          if (match) {
             await courseHandle.selectOption(match.value);
             // Dispatch change for course too
             await courseHandle.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
          } else {
             console.warn(`Course option "${courseName}" not found in dropdown.`);
             continue; 
          }
      } else {
          console.warn('Course dropdown not found.');
          continue;
      }
      
      await sleep(1500);

      // Listen for server response timestamp
      const responsePromise = page.waitForResponse(resp => 
        resp.url().toLowerCase().includes('launchbatchdetail.aspx') && resp.status() === 200
      ).catch(() => null);

      // Click "Get List"
      const btn = await page.$('input[type="submit"], input[type="button"][value="Get List"], a.btn');
      if (btn) {
          try { 
            await btn.click({ timeout: 5000 }); 
            console.log('Clicked "Get List" button.');
          } catch(e) { console.log('Click failed'); }
      } else {
          // Fallback xpath
           const el = await page.$(`xpath=//input[contains(@value,"Get List")]`);
           if(el) await el.click();
      }

      await sleep(3000);

      // Capture Timestamp
      const response = await responsePromise;
      if (response && response.headers()['date']) {
        serverDataTimestamp = response.headers()['date'];
      }

      // Check for Table
      const tableHandle = await page.$('table');
      if (!tableHandle) {
        console.log(`No results table found for ${courseName}.`);
        continue;
      }

      // Parse Table
      const seatResults = await page.evaluate(() => {
        const tbl = document.querySelector('table');
        if (!tbl) return [];
        
        const headerRow = Array.from(tbl.querySelectorAll('tr')).find(r => Array.from(r.cells).some(c => /Available\s*Seats/i.test(c.innerText)));
        if (!headerRow) return [];
        
        const colIndex = Array.from(headerRow.cells).findIndex(c => /Available\s*Seats/i.test(c.innerText));
        if (colIndex === -1) return [];

        return Array.from(tbl.querySelectorAll('tr')).slice(1).map(row => {
          const cells = Array.from(row.cells).map(c => c.innerText.trim());
          let seats = cells[colIndex];
          if (!seats) seats = cells.find(c => /^\d+$/.test(c)) || '0';
          return { batch: cells[0], seats: seats };
        });
      });

      // Filter Positive
      const positive = seatResults.filter(r => parseInt(r.seats.replace(/\D/g,'') || '0', 10) > 0);

      if (positive.length > 0) {
        console.log(`FOUND SEATS for ${courseName}!`);
        positive.forEach(p => allFoundSeats.push({ course: courseName, batch: p.batch, seats: p.seats }));
      } else {
        console.log(`No available seats found for ${courseName}.`);
      }
      
      await sleep(1000);
    } 

    await browser.close();

    // --- PHASE 4: NOTIFICATIONS ---
    if (allFoundSeats.length > 0) {
      const timeMsg = `ICAI Data Timestamp: ${serverDataTimestamp}`;
      const header = `🚨 ICAI SEATS AVAILABLE! (${allFoundSeats.length} batches)`;
      const details = allFoundSeats.map(p => `• ${p.course}\n   Batch: ${p.batch} -> ${p.seats} Seats`).join('\n\n');
      const msg = `${header}\n${timeMsg}\n\n${details}\n\nLink: ${targetURL}`;

      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
