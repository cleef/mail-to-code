import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeAgentGuide, readAgentGuide, agentGuidePath } from '../src/agent-guide.js';
test('Standalone AGENTS.md is privately initialized, editable immediately, and preserved across installation',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'mail-guide-'));
    try{
        assert.match(await readAgentGuide(directory),/Operator guide/);
        assert.equal((await initializeAgentGuide(directory)).created,true);
        const path=agentGuidePath(directory);assert.equal((await stat(path)).mode&0o777,0o600);
        await writeFile(path,'# 人工约定\n示例笔记小程序优先核对首页与快照。',{mode:0o600});
        assert.match(await readAgentGuide(directory),/人工约定/);
        assert.equal((await initializeAgentGuide(directory)).created,false);
        assert.match(await readAgentGuide(directory),/人工约定/);
        await writeFile(path,'# 新约定\n使用新的测试 fixture。');assert.match(await readAgentGuide(directory),/新的测试 fixture/);
    }finally{await rm(directory,{recursive:true,force:true});}
});
test('Agent guide rejects credentials, oversized/public files and symlinks without exposing content',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'mail-guide-'));
    try{
        const path=agentGuidePath(directory);
        await writeFile(path,'refresh_token=synthetic',{mode:0o600});await assert.rejects(readAgentGuide(directory),/possible credentials/);
        await writeFile(path,'x'.repeat(32769));await assert.rejects(readAgentGuide(directory),/32 KiB/);
        await rm(path);await writeFile(path,'# public',{mode:0o644});await chmod(path,0o644);await assert.rejects(readAgentGuide(directory),/600/);
        await rm(path);await symlink('/etc/passwd',path);await assert.rejects(readAgentGuide(directory),/regular private file/);
    }finally{await rm(directory,{recursive:true,force:true});}
});
