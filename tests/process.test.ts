import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { execute } from '../src/process.js';
test('timeout and cancellation terminate a running process',async()=>{
  await assert.rejects(execute(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:100}),/PROCESS_TIMEOUT/);
  const abort=new AbortController();const running=execute(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:abort.signal});setTimeout(()=>abort.abort(),100);await assert.rejects(running,/CANCELLED/);
});
test('SQLite history cursor and IDs survive reopening; newer schema cannot be silently downgraded',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mail-to-code-db-'));try{
    const path=join(dir,'state.sqlite');let store=new Store(path);const id=store.newId(new Date('2026-09-30T00:00:00Z'));store.set('gmail_history','100');store.close();
    store=new Store(path);assert.equal(store.get('gmail_history'),'100');assert.notEqual(store.newId(new Date('2026-09-30T00:00:00Z')),id);store.set('schema_version','3');store.migrate(s=>s);assert.equal(store.get('schema_version'),'3');store.set('schema_version','8');store.close();assert.throws(()=>new Store(path),/migration required/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

import { disabledMcpPolicy } from '../src/runner.js';
test('Disabling an inventory-only MCP server supplies a valid inert transport without retaining its configuration',()=>{
 assert.deepEqual(disabledMcpPolicy([{name:'code-review'},{name:'http-server',transport:{type:'streamable_http'}}]),['-c','mcp_servers.code-review={command="/usr/bin/true",enabled=false}','-c','mcp_servers.http-server={url="https://invalid.invalid/",enabled=false}']);
 assert.throws(()=>disabledMcpPolicy([{name:'bad.name'}]),/MCP_NAME/);
});
