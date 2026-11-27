#!/usr/bin/env node
import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {loadConfig,listBackups,validateManifest} from './backup-core.mjs';
try{
 const file=process.argv[2];if(!file||process.argv.length!==3)throw Error();
 const config=await loadConfig(file);
 const backups=await listBackups(config);
 let job=null;
 const statusFile=path.join(path.dirname(file),'last-run.json');
 const stat=await lstat(statusFile).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
 if(stat){
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error();
  const value=JSON.parse(await readFile(statusFile,'utf8'));
  if(value.format!=='kuvi-backup-job-status'||value.version!==1||!['running','succeeded','failed'].includes(value.state))throw Error();
  job={state:value.state,startedAt:value.startedAt,finishedAt:value.finishedAt??null};
 }
 const latest=backups.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0]??null;
 let nas=null;
 const nasFile=path.join(path.dirname(file),'last-nas-push.json');
 const nasStat=await lstat(nasFile).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
 if(nasStat){
  if(!nasStat.isFile()||nasStat.isSymbolicLink()||nasStat.uid!==process.getuid()||(nasStat.mode&0o077))throw Error();
  const value=JSON.parse(await readFile(nasFile,'utf8'));
  if(value.format!=='kuvi-nas-push-status'||value.version!==1||!['running','succeeded','failed'].includes(value.state))throw Error();
  nas={state:value.state,startedAt:value.startedAt,finishedAt:value.finishedAt??null,latest:value.latest?validateManifest(value.latest):null,lastSuccessAt:value.lastSuccessAt??null,lastSuccessLatest:value.lastSuccessLatest?validateManifest(value.lastSuccessLatest):null};
 }
 console.log(JSON.stringify({ok:true,format:'kuvi-backup-health',version:1,checkedAt:new Date().toISOString(),count:backups.length,latest,job,nas}));
}catch{console.error(JSON.stringify({ok:false,code:'BACKUP_HEALTH_CHECK_FAILED'}));process.exitCode=1;}
