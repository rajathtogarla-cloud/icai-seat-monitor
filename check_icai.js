// check_icai.js — Final Resilient Version (Syntax Fixed)
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
          el.dispatchEvent(new Event('blur')); 
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
    
    const regionSuccess = await forceSelectOption('#ddl_reg', REGION_TEXT);
    if (!regionSuccess) throw new Error(`Could not select Region: ${REGION_TEXT}`);
    
    console.log('Region selected. Waiting for POU update...');
    
    // Wait for network idle after region change
    try {
        await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch(e) {
        console.log('Network idle wait timed out, proceeding...');
    }
    await sleep(2000);

    // --- PHASE 2: POU SELECTION ---
    console.log(`Attempting to select POU: ${POU_TEXT}...`);
    
    // Wait for POU to be enabled
    try {
      await page.waitForSelector('#ddl_pou:not([disabled])', { state: 'visible', timeout: 10000 });
    } catch(e) {
      console.warn('POU dropdown did not become enabled. Region selection might have failed silently.');
    }

    const pouSuccess = await forceSelectOption('#ddl_pou', POU_TEXT);
    if (!pouSuccess) {
       console.warn(`Failed to select POU: ${POU_TEXT}. checking courses anyway.`);
    } else {
       console.log('Region and POU successfully configured.');
    }
    await sleep(2000);


    // --- PHASE 3: CHECK EACH COURSE ---
    for (const courseName of COURSES_TO_CHECK) {
      console.log(`\n--- Checking Course: ${courseName} ---`);

      // Try finding course dropdown (ID can vary slightly on some pages)
      let courseHandle = await page.$('#ddl_course');
      if (!courseHandle) {
         courseHandle = await page.$('select[name*="course"]');
      }

      if (courseHandle) {
          const opts = await courseHandle.$$eval('option', options =>
