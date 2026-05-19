const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const authFile = 'tests/e2e/.auth/admin.json';
  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: authFile });
  const page = await context.newPage();

  const searchTerms = ['ImaTestAccount', 'sumco75@gmail.com', 'phwalpine.onmicrosoft.com', 'JB Test3'];

  async function checkPage(url, label) {
    console.log(`--- Visiting ${label}: ${url} ---`);
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      const body = await page.innerText('body');
      
      searchTerms.forEach(term => {
        if (body.includes(term)) {
          console.log(`MATCH FOUND: "${term}" on ${label}`);
        }
      });

      // Body snippet (first 500 chars)
      console.log(`Snippet: ${body.substring(0, 500).replace(/\n+/g, ' ')}...`);

      // Find Admin/User links
      const links = await page.$$eval('a, button', elements => 
        elements
          .map(el => ({ text: el.innerText, href: el.href || '' }))
          .filter(link => /user|admin/i.test(link.text) || /user|admin/i.test(link.href))
      );
      if (links.length > 0) {
        console.log('Relevant Links/Buttons:');
        links.forEach(l => console.log(` - [${l.text.trim()}] (${l.href})`));
      }
    } catch (e) {
      console.log(`Error visiting ${url}: ${e.message}`);
    }
    console.log('');
  }

  await checkPage('https://app.phwcoloradoalpine.org/admin', 'Admin Page');
  await checkPage('https://app.phwcoloradoalpine.org/members', 'Members Page');

  await browser.close();
})();
