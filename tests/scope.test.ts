import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigSchema} from '../src/config.js';
import {Runner,ResultSchema,OUTPUT_SCHEMA} from '../src/runner.js';
import {ScopeDecisionSchema,scopeInventory,validateScope,ScopeResolutionError,type ScopeDecision} from '../src/scope.js';
import type {Session,RepoExecution} from '../src/types.js';

const t=(id:string,extra:Partial<RepoExecution>={})=>({projectId:id,identity:'identity-'+id,path:'/synthetic/'+id,relativePath:id,displayName:'项目 '+id,worktree:'/synthetic/work/'+id,...extra} as RepoExecution);
const session=()=>({id:'SYNTHETIC-SCOPE',repo:'web',targets:[t('web'),t('mini'),t('records',{auxiliary:true,recordEvidence:true})],references:[t('reference')],workflow:{stageId:'stage-1',number:1,confirmed:true,confirmedPlan:'同版本方案',history:[]}} as unknown as Session);
const request=(id:string,role:'modify'|'reference'|'product_record'='modify')=>({projectId:id,identity:'identity-'+id,path:null,role,reason:'继续后续仓库工作'});
const decision=(requests:ScopeDecision['requests']=[],kind:ScopeDecision['decision']='within_approved_scope'):ScopeDecision=>({decision:kind,reason:'批准范围内继续',requests,questions:[]});

test('Scope inventory exposes current identity, approved roles and completion facts',()=>{
 const s=session();s.targets![1].reviewSha='reviewed';s.targets![2].mergeSha='merged';
 const inventory=scopeInventory(s);assert.equal(inventory[0].current,true);assert.equal(inventory[1].status,'review_ready');assert.equal(inventory[2].status,'merged');assert.equal(inventory[2].role,'product_record');assert.equal(inventory[3].role,'reference');
 assert.deepEqual(validateScope(s,decision([request('mini'),request('records','product_record'),request('web','reference')])),[]);
 // Evidence collection does not remove an existing model write grant.
 s.targets![0].recordEvidence=true;assert.equal(scopeInventory(s)[0].role,'modify');assert.deepEqual(validateScope(s,decision([request('web')])),[]);
});
test('Structured scope checks reject identity errors and contradictory permission claims',()=>{
 const s=session();
 assert.throws(()=>validateScope(s,decision([{...request('mini'),identity:'forged'}])),/IDENTITY/);
 assert.throws(()=>validateScope(s,decision([request('unknown')])),/IDENTITY/);
 assert.throws(()=>validateScope(s,decision([request('reference')])),/CONTRADICTION/);
 assert.throws(()=>validateScope(s,decision([], 'propose_scope_change')),/CONTRADICTION/);
 assert.throws(()=>validateScope(s,decision([request('mini'),request('mini')])),/DUPLICATE/);
 assert.match(validateScope(s,decision([request('reference')],'propose_scope_change'))[0],/reference → modify/);
 const newRepo={projectId:null,identity:null,path:'backend',role:'modify' as const,reason:'新接口'};
 assert.match(validateScope(s,decision([request('mini'),newRepo],'propose_scope_change'))[0],/未批准 → modify/);
 for(const path of ['/outside','../outside','web','a//b'])assert.throws(()=>validateScope(s,decision([{...newRepo,path}],'propose_scope_change')));
});
test('Missing context needs a concrete human fact; fresh output replaces legacy strings',()=>{
 const d=decision([],'need_context');assert.throws(()=>validateScope(session(),d),/QUESTION/);
 d.questions=[{text:'只能由负责人提供的新系统目录在哪里？',kind:'open',dependsOn:[],humanReason:'目录未提供且无法从当前上下文查明',options:[]}];
 assert.deepEqual(validateScope(session(),ScopeDecisionSchema.parse(d)),[]);
 assert.ok(OUTPUT_SCHEMA.required.includes('scopeDecision'));assert.ok(!OUTPUT_SCHEMA.required.includes('requestedProjects'));
 assert.ok(!('requestedProjects' in OUTPUT_SCHEMA.properties));
 assert.equal(ResultSchema.parse({outcome:'blocked',summary:'真实阻塞',questions:[],requiresBackend:false,screenshotTargets:[],requestedProjects:['历史描述']}).requestedProjects![0],'历史描述');
});

test('Legacy strings and invalid/mixed structured scope receive exactly one read-only semantic repair',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scope-repair-test-'));
 try{
  const runner=new Runner(ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',dataDir:root,projectsRoot:root}));
  const result={summary:'代码尚未完成',outcome:'needs_input',questions:['真正的业务问题'],requestedProjects:['手机端：继续标签交互','产品记录：回填验证证据']};
  const before=structuredClone(result);let calls=0;
  runner.interpret=async(dir,schema,prompt)=>{calls++;assert.ok(dir.startsWith(root));assert.ok(prompt.includes('手机端：继续标签交互'));assert.ok(prompt.includes('identity-mini'));return decision([request('mini'),request('records','product_record')]);};
  assert.equal((await runner.resolveScope(session(),result,new AbortController().signal))!.decision,'within_approved_scope');assert.equal(calls,1);assert.deepEqual(result,before);
  // A valid new decision needs no model roundtrip.
  await runner.resolveScope(session(),{...result,requestedProjects:[],scopeDecision:decision()},new AbortController().signal);assert.equal(calls,1);
  await runner.resolveScope(session(),{...result,scopeDecision:decision()},new AbortController().signal);assert.equal(calls,2);
  runner.interpret=async()=>{calls++;return decision([request('mini')]);};
  await runner.resolveScope(session(),{...result,requestedProjects:[],scopeDecision:decision([{...request('mini'),identity:'incorrect'}])},new AbortController().signal);assert.equal(calls,3);
  runner.interpret=async()=>{calls++;return decision([request('reference')]);};
  await assert.rejects(()=>runner.resolveScope(session(),result,new AbortController().signal),ScopeResolutionError);assert.equal(calls,4);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Executor scope repair keeps completion facts and does not interpret legacy output twice',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scope-run-test-')),previous=process.env.MAIL_TO_CODE_CONFIG_DIR;
 process.env.MAIL_TO_CODE_CONFIG_DIR=join(root,'guides');
 try{
  const runner=new Runner(ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',dataDir:root,projectsRoot:root}));
  const s=session();s.worktree=root;s.title='合成任务';
  const raw={outcome:'needs_input',summary:'真实未完成',questions:['缺少业务目标'],requiresBackend:false,screenshotTargets:[],requestedProjects:['示例手机后续实施']};
  let repairs=0;
  (runner as any).invoke=async(cwd:unknown,thread:unknown,policy:unknown,schema:unknown,prompt:string)=>{
   assert.ok(prompt.includes('identity-mini'));assert.ok(prompt.includes('当前执行仓库 ID：web'));assert.ok(prompt.includes('当前仓库尚未完成'));return structuredClone(raw);
  };
  runner.interpret=async()=>{repairs++;return decision([request('mini')]);};
  const result=await runner.run(s,'develop','合成反馈',new AbortController().signal,()=>{});
  assert.equal(result.outcome,'needs_input');assert.deepEqual(result.questions,raw.questions);assert.equal(result.requestedProjects,undefined);
  await runner.resolveScope(s,result,new AbortController().signal);assert.equal(repairs,1);
 }finally{if(previous===undefined)delete process.env.MAIL_TO_CODE_CONFIG_DIR;else process.env.MAIL_TO_CODE_CONFIG_DIR=previous;await rm(root,{recursive:true,force:true});}
});
