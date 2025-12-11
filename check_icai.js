// --- START OF CORRECTED SELECTION LOGIC ---
    
    // Helper to select an option by visible text for a <select> element
    // We will use this helper with specific IDs for reliability.
    async function selectByLabel(selectLocator, visibleText) {
      const options = await page.$$eval(`${selectLocator} option`, opts => opts.map(o => ({ value: o.value, text: o.innerText.trim() })));
      const match = options.find(o => o.text.toLowerCase().includes(visibleText.toLowerCase()));
      if (match) {
        await page.selectOption(selectLocator, match.value);
        return true;
      }
      return false;
    }

    // Target the dropdowns using their common IDs and select the required text.
    
    // 1) Region -> ID: ddl_reg
    let foundRegion = await selectByLabel('#ddl_reg', 'Southern');
    if (!foundRegion) {
      console.warn('Could not select Southern Region by ID #ddl_reg. Retrying with generic selector.');
    }
    
    // 2) POU -> ID: ddl_pou
    // Wait for POU options to load after selecting Region
    await page.waitForTimeout(2000); 
    let foundPou = await selectByLabel('#ddl_pou', 'HYDERABAD');
    if (!foundPou) {
      console.warn('Could not select HYDERABAD POU by ID #ddl_pou. Retrying with generic selector.');
    }

    // 3) Course -> ID: ddl_course
    // Wait for Course options to load after selecting POU
    await page.waitForTimeout(2000);
    let foundCourse = await selectByLabel('#ddl_course', 'Advanced (ICITSS) MCS'); 
    if (!foundCourse) {
      console.warn('Could not select Advanced (ICITSS) MCS by ID #ddl_course. Retrying with generic selector.');
    }
    
    if (!foundRegion || !foundPou || !foundCourse) {
      // Fallback to the original generic (but slower) logic if IDs fail (unlikely)
      console.warn("One or more selections failed by ID. Falling back to generic indexing.");
      
      const allSelects = await page.$$('select');
      // Try selecting by scanning each select element for the desired option
      const desired = [
        { text: 'Southern' },
        { text: 'HYDERABAD' },
        { text: 'Advanced (ICITSS) MCS' } // partial match allowed
      ];
      
      for (let i = 0; i < desired.length; ++i) {
        for (let idx = 0; idx < allSelects.length; ++idx) {
          const selector = `select:nth-of-type(${idx+1})`;
          const ok = await selectByLabel(selector, desired[i].text);
          if (ok) { break; } 
        }
      }
    }
    
    // --- END OF CORRECTED SELECTION LOGIC ---
