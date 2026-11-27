import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateBackupHealth,notificationDecision,validLatest,directNasStatus} from '../ops/backup-observer-core.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const now=Date.parse('2026-11-27T12:00:00Z'),hour=3600000;
const iso=hours=>new Date(now-hours*hour).toISOString();
const latest={filename:'kuvi-db-20261127T093001Z-1234abcd.dump.gpg',createdAt:iso(2),sha256:'a'.repeat(64),sourceIdentity:'b'.repeat(64),bytes:123};
const input=()=>({now,sourceIdentity:latest.sourceIdentity,report:{ok:true,format:'kuvi-backup-health',version:1,checkedAt:iso(0),latest:{...latest},job:{state:'succeeded',startedAt:iso(2),finishedAt:iso(2)}},pullStatus:{ok:true,at:iso(0.2)},nasPullStatus:{ok:true,at:iso(0.1)},pcCopy:'ok',nasCopy:'ok'});
test('fresh server job and verified copies are healthy',()=>assert.deepEqual(evaluateBackupHealth(input()).codes,[]));
test('unreachable server is never reported healthy from cached pull status',()=>assert.ok(evaluateBackupHealth({...input(),report:null}).codes.includes('SERVER_CHECK_FAILED')));
test('failed job is detected even with a fresh previous backup',()=>{const v=input();v.report.job.state='failed';assert.ok(evaluateBackupHealth(v).codes.includes('SERVER_BACKUP_JOB_FAILED'));});
test('stalled job and absent job status are detected',()=>{
 const v=input();v.report.job={state:'running',startedAt:iso(1.5)};assert.ok(evaluateBackupHealth(v).codes.includes('SERVER_BACKUP_JOB_STALLED'));
 v.report.job=null;assert.ok(evaluateBackupHealth(v).codes.includes('SERVER_JOB_STATUS_MISSING'));
});
test('stale archive and future timestamp are detected',()=>{
 const v=input();v.report.latest.createdAt=iso(37);assert.ok(evaluateBackupHealth(v).codes.includes('SERVER_BACKUP_STALE'));
 v.report.latest.createdAt=iso(-1);assert.ok(evaluateBackupHealth(v).codes.includes('BACKUP_CLOCK_INVALID'));
});
test('a changed source and unsafe archive names are rejected',()=>{
 const v=input();v.report.latest.sourceIdentity='c'.repeat(64);assert.ok(evaluateBackupHealth(v).codes.includes('BACKUP_SOURCE_CHANGED'));
 assert.equal(validLatest({...latest,filename:'../secret'}),false);
});
test('pending new copies have a bounded grace period',()=>{
 const v=input();v.pcCopy=v.nasCopy='missing';v.report.latest.createdAt=iso(0.1);
 assert.equal(evaluateBackupHealth(v).ok,true);assert.equal(evaluateBackupHealth(v).pending.length,2);
 v.report.latest.createdAt=iso(3);assert.ok(evaluateBackupHealth(v).codes.includes('NAS_COPY_MISSING'));
});
test('corruption and NAS connection failures are immediately errors',()=>{
 assert.ok(evaluateBackupHealth({...input(),nasCopy:'corrupt'}).codes.includes('NAS_COPY_CORRUPT'));
 assert.ok(evaluateBackupHealth({...input(),nasCopy:'unavailable'}).codes.includes('NAS_UNAVAILABLE'));
});
test('failed or stale transfer tasks are detected separately',()=>{
 const v=input();v.pullStatus={ok:false,at:iso(0)};v.nasPullStatus={ok:true,at:iso(4)};
 assert.ok(evaluateBackupHealth(v).codes.includes('PC_PULL_FAILED'));assert.ok(evaluateBackupHealth(v).codes.includes('NAS_PULL_STALE'));
});
test('invalid observer clock or transfer timestamp cannot mask a problem',()=>{
 const v=input();v.report.checkedAt=iso(-1);v.pullStatus.at='invalid';
 assert.ok(evaluateBackupHealth(v).codes.includes('SERVER_CLOCK_OR_REPORT_INVALID'));assert.ok(evaluateBackupHealth(v).codes.includes('PC_PULL_STATUS_INVALID'));
});
test('notification is deduplicated and repeated after six hours',()=>{
 const current={ok:false,codes:['NAS_UNAVAILABLE']};
 assert.equal(notificationDecision(null,current,now),'problem');
 assert.equal(notificationDecision({...current,lastNotifiedAt:iso(1)},current,now),null);
 assert.equal(notificationDecision({...current,lastNotifiedAt:iso(7)},current,now),'problem');
 assert.equal(notificationDecision({...current,lastNotifiedAt:iso(0.1)},{ok:false,codes:['SERVER_CHECK_FAILED']},now),'problem');
});
test('recovery produces one notification and unconfigured NAS is explicit',()=>{
 assert.equal(notificationDecision({ok:false,codes:['NAS_UNAVAILABLE']},{ok:true,codes:[]},now),'recovered');
 const v=input();v.requireNas=false;delete v.nasPullStatus;delete v.nasCopy;assert.equal(evaluateBackupHealth(v).ok,true);
});
test('a changed problem is retried until the new codes were actually notified',()=>{
 const current={ok:false,codes:['NAS_UNAVAILABLE']};
 const previous={...current,lastNotifiedAt:iso(0.1),lastNotifiedCodes:['PC_PULL_FAILED']};
 assert.equal(notificationDecision(previous,current,now),'problem');
});
test('twelve-hour NAS schedule has its own freshness and copy grace thresholds',()=>{
 const v=input();v.maxNasPullAgeHours=15;v.nasCopyGraceHours=14;v.nasPullStatus.at=iso(12.5);v.nasCopy='missing';v.report.latest.createdAt=iso(3);
 let result=evaluateBackupHealth(v);assert.equal(result.ok,true);assert.ok(result.pending.includes('NAS_COPY_PENDING'));
 v.nasPullStatus.at=iso(16);assert.ok(evaluateBackupHealth(v).codes.includes('NAS_PULL_STALE'));
 v.nasPullStatus.at=iso(12.5);v.report.latest.createdAt=iso(14.1);assert.ok(evaluateBackupHealth(v).codes.includes('NAS_COPY_MISSING'));
 v.report.latest.createdAt=iso(3);v.nasPullStatus.ok=false;assert.ok(evaluateBackupHealth(v).codes.includes('NAS_PULL_FAILED'));
 v.nasPullStatus.ok=true;v.pullStatus.at=iso(4);assert.ok(evaluateBackupHealth(v).codes.includes('PC_PULL_STALE'));
});
test('direct NAS is independent of an old laptop copy',()=>{
 const v=input();v.requirePcCopy=false;v.pullStatus=null;v.pcCopy='not-required';v.report.nas={state:'succeeded',finishedAt:iso(0.5),latest:{...latest}};
 Object.assign(v,directNasStatus(v.report,now));assert.equal(evaluateBackupHealth(v).ok,true);
 v.report.nas.latest.sha256='c'.repeat(64);assert.equal(directNasStatus(v.report,now).nasCopy,'missing');
});
test('direct NAS transfer failure and stalled running state are detected',()=>{
 const v=input();v.report.nas={state:'failed',finishedAt:iso(0.1)};Object.assign(v,directNasStatus(v.report,now));
 assert.ok(evaluateBackupHealth(v).codes.includes('NAS_PULL_FAILED'));
 v.report.nas={state:'running',startedAt:iso(2),lastSuccessAt:iso(3),lastSuccessLatest:{...latest}};
 assert.equal(directNasStatus(v.report,now).nasPullStatus.ok,false);
});
test('direct NAS running state preserves a recent verification but rejects missing status',()=>{
 const v=input();v.report.nas={state:'running',startedAt:iso(0.1),lastSuccessAt:iso(2),lastSuccessLatest:{...latest}};
 const status=directNasStatus(v.report,now);assert.equal(status.nasCopy,'ok');assert.equal(status.nasPullStatus.ok,true);
 assert.equal(directNasStatus({...v.report,nas:null},now).nasPullStatus,null);
});
test('file checker accepts matching ciphertext and catches corruption or unreachable folders',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'kuvi-observer-test-'));
 try{
  const bytes=Buffer.from('synthetic encrypted archive');
  const manifest={...latest,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  await writeFile(path.join(root,manifest.filename),bytes);
  const cli=fileURLToPath(new URL('../ops/backup-observer.mjs',import.meta.url));
  const check=directory=>{
   const result=spawnSync(process.execPath,[cli,'--copy-check',directory],{input:JSON.stringify(manifest),encoding:'utf8',timeout:10000});
   assert.equal(result.status,0);return JSON.parse(result.stdout).status;
  };
  assert.equal(check(root),'ok');
  await writeFile(path.join(root,manifest.filename),Buffer.from('x'.repeat(bytes.length)));
  assert.equal(check(root),'corrupt');
  const empty=path.join(root,'empty');await mkdir(empty);assert.equal(check(empty),'missing');
  assert.equal(check(path.join(root,'unreachable')),'unavailable');
 }finally{await rm(root,{recursive:true});}
});
