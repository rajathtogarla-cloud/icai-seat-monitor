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
  const COURSES = ['Advanced (ICITSS) MCS', 'Advanced Information Technology'];

  let allFoundSeats = [];
  let serverDataTimestamp = 'Unknown';

  const browser = await chromium.launch({
    headless: true, args: ['--no-sandbox','--disable-dev-shm-usage']
  });
  const page = await browser.newPage();

  async function forceSelectOption(selector, text) {
    const handle = await page.$(selector);
    if (!handle) return false;
    const opts = await handle.$$eval('option', options => options.map(o => ({ value: o.value, text: o.innerText.trim() })));
    const match = opts.find(o => o.text.toLowerCase().includes(text.toLowerCase()));
    if (match) {
      await handle.selectOption(match.value);
      await handle.evaluate(el => {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur')); 
      });
      return true;
    }
    return false;
  }

  try {
    console.log('Navigating...');
    await page.goto(targetURL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000);

    console.log(`Selecting Region: ${REGION_TEXT}`);
    const regionSuccess = await forceSelectOption('#ddl_reg', REGION_TEXT);
    if (!regionSuccess) throw new Error(`Could not select Region`);
    
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch(e) {}
    await sleep(2000);

    console.log(`Selecting POU: ${POU_TEXT}`);
    try { await page.waitForSelector('#ddl_pou:not([disabled])', { state: 'visible', timeout: 10000 }); } catch(e) {}

    const pouSuccess = await forceSelectOption('#ddl_pou', POU_TEXT);
    if (!pouSuccess) console.warn(`Failed to select POU.`);
    await sleep(2000);

    for (const courseName of COURSES) {
      console.log(`Checking: ${courseName}`);
      let courseHandle = await page.$('#ddl_course') || await page.$('select[name*="course"]');

      if (courseHandle) {
          const opts = await courseHandle.$$eval('option', options => options.map(o => ({ value: o.value, text: o.innerText.trim() })));
          const match = opts.find(o => o.text.toLowerCase().includes(courseName.toLowerCase()));
          if (match) {
             await courseHandle.selectOption(match.value);
             await courseHandle.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
          } else {
             console.warn(`Option "${courseName}" not found.`);
             continue; 
          }
      } else {
          console.warn('Course dropdown not found.');
          continue;
      }
      
      await sleep(1500);
      const responsePromise = page.waitForResponse(resp => resp.url().toLowerCase().includes('launchbatchdetail.aspx') && resp.status() === 200).catch(() => null);

      const btn = await page.$('input[type="submit"], input[type="button"][value="Get List"], a.btn');
      if (btn) {
          try { await btn.click({ timeout: 5000 }); } catch(e) {}
      } else {
           const el = await page.$(`xpath=//input[contains(@value,"Get List")]`);
           if(el) await el.click();
      }

      await sleep(3000);
      const response = await responsePromise;
      if (response && response.headers()['date']) serverDataTimestamp = response.headers()['date'];

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

      const positive = seatResults.filter(r => parseInt(r.seats.replace(/\D/g,'') || '0', 10) > 0);
      if (positive.length > 0) {
        console.log(`FOUND SEATS for ${courseName}!`);
        positive.forEach(p => allFoundSeats.push({ course: courseName, batch: p.batch, seats: p.seats }));
      } else {
        console.log(`No seats for ${courseName}.`);
      }
      await sleep(1000);
    } 

    await browser.close();

    if (allFoundSeats.length > 0) {
      const msg = `🚨 ICAI SEATS!\nTime: ${serverDataTimestamp}\n\n` + allFoundSeats.map(p => `• ${p.course}\n   Batch: ${p.batch} -> ${p.seats}`).join('\n') + `\n\n${targetURL}`;
      
      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
        });
      }
      if (SMTP_HOST && EMAIL_TO) {
        const transporter = nodemailer.createTransport({
          host: SMTP_HOST, port: Number(SMTP_PORT), secure: Number(SMTP_PORT) === 465,
          auth: { user: SMTP_USER, pass: SMTP_PASS }
        });
        await transporter.sendMail({ from: SMTP_USER, to: EMAIL_TO, subject: 'ICAI SEATS ALERT', text: msg });
      }
      console.log('Alert Sent!');
    } else {
      console.log(`No seats found. (Server Time: ${serverDataTimestamp})`);
    }
    process.exit(0);

  } catch (err) {
    console.error('Error:', err);
    try { await browser.close(); } catch(e){}
    process.exit(1);
  }
})();
