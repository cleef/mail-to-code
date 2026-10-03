import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { staticServer } from './server.mjs';

const input=JSON.parse(await readFile('/input.json','utf8'));
const server=staticServer('/site');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
const checks=[],images=[];
try{
  for(const path of input.checkPaths){if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Invalid check path');const r=await fetch(origin+path);if(!r.ok)throw new Error(`Entry failed: ${path} ${r.status}`);checks.push(`${path}: ${r.status}`);}
  for(const [index,target] of input.targets.entries()){
    if(!target.path.startsWith('/')||target.path.startsWith('//'))throw new Error('Invalid screenshot path');
    for(const [device,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]]){
      const context=await browser.newContext({viewport,isMobile:device==='mobile',hasTouch:device==='mobile'});
      const fixtures=input.fixtures;
      if(fixtures?.storage)await context.addInitScript(storage=>{for(const [key,value] of Object.entries(storage))localStorage.setItem(key,typeof value==='string'?value:JSON.stringify(value));},fixtures.storage);
      await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();
        if(!url.hostname.endsWith('.invalid'))return route.abort();
        const rule=fixtures?.routes?.find(r=>r.pathname===url.pathname&&(!r.method||r.method===route.request().method()));
        if(!rule)return route.abort();const headers={'access-control-allow-origin':origin,'access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS','access-control-allow-headers':'authorization,content-type'};await route.fulfill({status:route.request().method()==='OPTIONS'?204:rule.status||200,headers,contentType:'application/json',body:route.request().method()==='OPTIONS'?'':JSON.stringify(rule.json)});
      });
      const page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      const response=await page.goto(origin+target.path,{waitUntil:'networkidle',timeout:30000});if(!response?.ok())throw new Error('Screenshot page failed');
      for(const step of target.steps){const locator=page.locator(step.selector);if(step.action==='click')await locator.click();else if(step.action==='fill')await locator.fill(step.value);else if(step.action==='wait')await locator.waitFor({state:'visible'});else throw new Error('Unsupported screenshot action');}
      // Router transitions can expose a visible DOM node while it is still
      // outside the viewport. Wait for finite animations and stable geometry.
      await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
      const stableSelector=target.steps.filter(s=>s.action==='wait').at(-1)?.selector;
      if(stableSelector)await page.waitForFunction(selector=>{const el=document.querySelector(selector);if(!el)return false;const r=el.getBoundingClientRect();if(!r.width||!r.height||r.right<=0||r.left>=innerWidth||r.bottom<=0||r.top>=innerHeight)return false;const key=[r.x,r.y,r.width,r.height].join(',');const last=window.__previewGeometry;window.__previewGeometry={key,count:last?.key===key?last.count+1:0};return window.__previewGeometry.count>=5;},stableSelector,{timeout:5000,polling:'raf'});
      await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;})));});
      const brokenImages=await page.evaluate(()=>[...document.images].filter(img=>img.getBoundingClientRect().width>0&&!img.naturalWidth).map(img=>img.getAttribute('src')));
      if(brokenImages.length)throw new Error(`Visible images failed to load: ${brokenImages.join(', ')}`);
      if(errors.length)throw new Error(`Browser page errors: ${errors.join('; ')}`);
      const name=`target-${index+1}-${device}.png`;await page.screenshot({path:`/output/${name}`,animations:'disabled',fullPage:false});images.push(name);checks.push(`${device} ${target.path}: render and interactions passed`);await context.close();
    }
  }
  await writeFile('/output/report.json',JSON.stringify({images,checks}));
}finally{await browser.close();server.close();}
