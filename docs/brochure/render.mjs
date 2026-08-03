import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
await p.goto('file://' + process.cwd() + '/brochure.html', { waitUntil:'networkidle' });
await p.pdf({ path:'QuickInsight-Brochure.pdf', format:'A4', printBackground:true,
              margin:{top:'0',right:'0',bottom:'0',left:'0'} });
// also a PNG so the layout can be eyeballed
await p.setViewportSize({ width: 794, height: 1123 });
await p.screenshot({ path:'brochure-preview.png', fullPage:true });
await b.close();
console.log('done');
