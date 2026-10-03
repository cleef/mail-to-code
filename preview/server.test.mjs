import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staticServer } from './server.mjs';

test('static preview serves home/SPA/apps/Spotlight; denies API, missing assets and symlink escape',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'mail-preview-')),root=join(temp,'site');
  await mkdir(join(root,'apps/demo'),{recursive:true});
  await writeFile(join(root,'index.html'),'HUB');await writeFile(join(root,'apps/demo/index.html'),'APP');await writeFile(join(root,'apps/demo/game-spotlight.html'),'SPOTLIGHT');
  await writeFile(join(temp,'private.html'),'PRIVATE');await symlink(join(temp,'private.html'),join(root,'escape.html'));
  const server=staticServer(root);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const [path,expected] of [['/','HUB'],['/math','HUB'],['/english','HUB'],['/app/demo','HUB'],['/apps/demo/','APP'],['/apps/demo/game-spotlight.html','SPOTLIGHT']])assert.equal(await (await fetch(origin+path)).text(),expected);
    for(const [path,status] of [['/api/session',401],['/missing.js',404],['/apps/missing/',404],['/escape.html',403],['/%2e%2e%2fprivate.html',403]])assert.equal((await fetch(origin+path)).status,status);
  }finally{await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}
});
