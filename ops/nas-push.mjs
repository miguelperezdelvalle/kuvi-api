#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {readFile,lstat,open,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './backup-core.mjs';
import {requireNasMount,copyBackupsToNas} from './nas-copy-core.mjs';
async function writeStatus(file,value){
 const part=file+'.'+randomUUID()+'.part',fd=await open(part,'wx',0o600);
 try{await fd.writeFile(JSON.stringify(value)+'\n');await fd.sync();}finally{await fd.close();}
 await rename(part,file);
}
async function main(){
 const [backupFile,nasFile,locked]=process.argv.slice(2);
 if(!backupFile||!nasFile||!path.isAbsolute(backupFile)||!path.isAbsolute(nasFile)||!['--locked',undefined].includes(locked)||process.argv.length>5)throw Error('INVALID_NAS_ARGUMENTS');
 const backup=await loadConfig(backupFile),stat=await lstat(nasFile);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('PRIVATE_NAS_CONFIG_REQUIRED');
 const config=JSON.parse(await readFile(nasFile,'utf8'));
 if(config.format!=='kuvi-nas-direct-config'||config.version!==1||config.mountPoint!=='/mnt/kuvi-nas'||config.directory!=='/mnt/kuvi-nas/database')throw Error('INVALID_NAS_CONFIG');
 if(!locked){
  const child=spawn('flock',['--exclusive','--nonblock','--conflict-exit-code','75',path.join(backup.outputDir,'.backup.lock'),process.execPath,fileURLToPath(import.meta.url),backupFile,nasFile,'--locked'],{stdio:'inherit'});
  process.exitCode=await new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('close',code=>resolve(code??1));});return;
 }
 const statusFile=path.join(path.dirname(nasFile),'last-nas-push.json');
 const previous=await readFile(statusFile,'utf8').then(JSON.parse).catch(()=>null);
 const status={format:'kuvi-nas-push-status',version:1,state:'running',startedAt:new Date().toISOString(),lastSuccessAt:previous?.state==='succeeded'?previous.finishedAt:previous?.lastSuccessAt??null,lastSuccessLatest:previous?.state==='succeeded'?previous.latest:previous?.lastSuccessLatest??null};
 await writeStatus(statusFile,status);
 try{
  await requireNasMount(config);
  const result=await copyBackupsToNas(backup,config.directory);
  await writeStatus(statusFile,{...status,state:'succeeded',finishedAt:new Date().toISOString(),...result});
  console.log(JSON.stringify({ok:true,verified:result.verified,copied:result.copied}));
 }catch{
  await writeStatus(statusFile,{...status,state:'failed',finishedAt:new Date().toISOString(),code:'NAS_PUSH_FAILED'});
  throw Error('NAS_PUSH_FAILED');
 }
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.message||'')?error.message:'NAS_PUSH_FAILED'}));process.exitCode=1;});
