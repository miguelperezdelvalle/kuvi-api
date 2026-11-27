// Explicit invocation on the operator's host; uses a separate temporary output and status.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file=process.argv[2];if(!file)throw Error('PRIVATE_CONFIG_PATH_REQUIRED');
const status=path.join(path.dirname(file),'last-run.json');
const before=await readFile(status);
const root=await mkdtemp(path.join(tmpdir(),'kuvi-job-failure-test-'));
try{
 const config=JSON.parse(await readFile(file,'utf8'));
 config.outputDir=path.join(root,'archives');config.pgDump='/bin/false';
 const testConfig=path.join(root,'config.json');await writeFile(testConfig,JSON.stringify(config),{mode:0o600});
 const cli=fileURLToPath(new URL('../ops/backup-job.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[cli,testConfig],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,1);
 const failed=JSON.parse(await readFile(path.join(root,'last-run.json'),'utf8'));
 assert.equal(failed.state,'failed');assert.equal(failed.code,'BACKUP_RUN_FAILED');assert.ok(failed.finishedAt);
 assert.deepEqual(await readFile(status),before);
 console.log(JSON.stringify({ok:true,failedJobRecorded:true,productionStatusUnchanged:true}));
}finally{await rm(root,{recursive:true});}
