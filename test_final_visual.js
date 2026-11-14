const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined });
  });

  await page.goto('http://localhost:5174', { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // 1. Check sidebar logo dimensions
  const logoBox = await page.locator('.sidebar-logo').boundingBox();
  console.log('Sidebar Logo dimensions:', logoBox);

  // 2. Check sidebar controls
  const toolsBox = await page.locator('.sidebar-canvas-tools').boundingBox();
  const toolButtons = await page.locator('.sidebar-canvas-tools button').allInnerTexts();
  console.log('Sidebar Controls:', { box: toolsBox, buttons: toolButtons });

  // 3. Select a node to open File Inspector
  await page.locator('#node-search-input').fill('analysis.ts');
  await page.waitForTimeout(500);
  await page.locator('.search-results button').first().click();
  await page.waitForTimeout(1000);

  // Take screenshot with File Inspector open
  await page.screenshot({ path: 'scratch_visual_file_inspector.png' });
  console.log('Saved scratch_visual_file_inspector.png');

  // Check Inspector grid structure
  const gridCells = await page.locator('.inspector-grid .inspector-cell').allInnerTexts();
  console.log('Inspector Grid Cells:\n', gridCells);

  // Check node styling in cytoscape
  const nodeStats = await page.evaluate(() => {
    const container = document.querySelector('.graph-surface');
    const cy = container?._cyreg?.cy;
    if (!cy) return null;
    const n = cy.nodes()[0];
    return {
      fontSize: n.style('font-size'),
      width: n.width(),
      height: n.height(),
      valign: n.style('text-valign'),
      halign: n.style('text-halign'),
      boundingBox: n.boundingBox()
    };
  });
  console.log('Node Stats:', nodeStats);

  // Check clicking empty canvas clears selection and focus
  await page.locator('.graph-surface').click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(500);
  const inspectorVisible = await page.locator('.dependency-inspector').isVisible();
  console.log('Inspector visible after clicking canvas:', inspectorVisible);

  await browser.close();
})();
