#!/usr/bin/env node
// Cron entry point. Emits only technical status; credentials and raw stderr stay private.
import {spawn} from 'node:child_process';
import {open,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './backup-core.mjs';
const [configFile,locked]=process.argv.slice(2);
async function atomicStatus(file,value){
 const part=file+'.'+randomUUID()+'.part';const fd=await open(part,'wx',0o600);
 try{await fd.writeFile(JSON.stringify(value)+'\n');await fd.sync();}finally{await fd.close();}
 await rename(part,file);
}
async function run(program,args){
 const child=spawn(program,args,{stdio:['ignore','pipe','pipe']});
 child.stdout.resume();child.stderr.resume();
 return new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('close',code=>resolve(code??1));});
}
async function main(){
 if(!configFile||!path.isAbsolute(configFile)||!['--locked',undefined].includes(locked)||process.argv.length>4)throw Error('INVALID_JOB_ARGUMENTS');
 const config=await loadConfig(configFile);
 if(!locked){
  process.exitCode=await run('flock',['--exclusive','--nonblock','--conflict-exit-code','75',path.join(config.outputDir,'.daily-job.lock'),process.execPath,fileURLToPath(import.meta.url),configFile,'--locked']);
  console.log(JSON.stringify(process.exitCode===0?{ok:true,backupJob:'succeeded'}:{ok:false,code:process.exitCode===75?'BACKUP_JOB_ALREADY_RUNNING':'BACKUP_JOB_FAILED'}));return;
 }
 const statusFile=path.join(path.dirname(configFile),'last-run.json');
 const status={format:'kuvi-backup-job-status',version:1,state:'running',startedAt:new Date().toISOString()};
 await atomicStatus(statusFile,status);
 let code='BACKUP_RUN_FAILED';
 try{
  const cli=path.join(path.dirname(fileURLToPath(import.meta.url)),'backup.mjs');
  if(await run(process.execPath,[cli,'run',configFile])!==0)throw Error(code);
  code='BACKUP_PRUNE_FAILED';
  if(await run(process.execPath,[cli,'prune',configFile])!==0)throw Error(code);
  await atomicStatus(statusFile,{...status,state:'succeeded',finishedAt:new Date().toISOString()});
  console.log(JSON.stringify({ok:true,backupJob:'succeeded'}));
 }catch{
  await atomicStatus(statusFile,{...status,state:'failed',finishedAt:new Date().toISOString(),code});
  throw Error(code);
 }
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.message||'')?error.message:'BACKUP_JOB_FAILED'}));process.exitCode=1;});
