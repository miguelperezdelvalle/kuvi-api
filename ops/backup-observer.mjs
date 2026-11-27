#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {readFile,lstat,open,rename,appendFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validLatest,evaluateBackupHealth,notificationDecision,directNasStatus} from './backup-observer-core.mjs';
async function command(program,args,input='',timeout=35000){
 const child=spawn(program,args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
 child.stderr.resume();let output='';
 child.stdout.on('data',bytes=>{output+=bytes.toString();if(output.length>1024*1024)child.kill();});
 child.stdin.on('error',()=>{});child.stdin.end(input);
 const timer=setTimeout(()=>child.kill(),timeout);
 try{await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('CHECK_FAILED')));});return JSON.parse(output);}
 finally{clearTimeout(timer);}
}
async function copyStatus(directory,latest){
 if(!path.isAbsolute(directory||'')||!validLatest(latest))return 'unavailable';
 try{if(!(await lstat(directory)).isDirectory())return 'unavailable';}catch{return 'unavailable';}
 try{
  const target=path.join(directory,latest.filename);
  const stat=await lstat(target);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==latest.bytes)return 'corrupt';
  const hash=createHash('sha256');for await(const chunk of createReadStream(target))hash.update(chunk);
  return hash.digest('hex')===latest.sha256?'ok':'corrupt';
 }catch(error){return error.code==='ENOENT'?'missing':'unavailable';}
}
async function main(){
 if(process.argv[2]==='--copy-check'){
  let input='';for await(const bytes of process.stdin){input+=bytes;if(input.length>16384)throw Error();}
  console.log(JSON.stringify({status:await copyStatus(process.argv[3],JSON.parse(input))}));return;
 }
 if(process.argv.length!==3||!path.isAbsolute(process.argv[2]))throw Error();
 const configFile=process.argv[2],root=path.dirname(configFile);
 const config=JSON.parse(await readFile(configFile,'utf8'));
 config.nasMode??='pc-pull';config.requirePcCopy??=true;
 if(config.format!=='kuvi-backup-observer-config'||config.version!==1||!/^[a-f0-9]{64}$/.test(config.sourceIdentity||'')||
    !path.isAbsolute(config.pullConfigFile||'')||!path.isAbsolute(config.pullStatusFile||'')||typeof config.requireNas!=='boolean'||
    typeof config.requirePcCopy!=='boolean'||!['pc-pull','server-direct'].includes(config.nasMode)||
    (config.requireNas&&config.nasMode==='pc-pull'&&(!path.isAbsolute(config.nasDirectory||'')||!path.isAbsolute(config.nasPullStatusFile||''))))throw Error();
 for(const [key,fallback,min,max] of [['maxBackupAgeHours',36,24,72],['maxPullAgeHours',3,1,24],['copyGraceHours',2,0,12],['maxNasPullAgeHours',config.maxPullAgeHours??3,1,48],['nasCopyGraceHours',config.copyGraceHours??2,0,24]]){
  config[key]??=fallback;if(!Number.isFinite(config[key])||config[key]<min||config[key]>max)throw Error();
 }
 const pull=JSON.parse(await readFile(config.pullConfigFile,'utf8'));
 if(!/^[A-Za-z0-9_-]{1,80}$/.test(pull.sshAlias||'')||!/^\/[A-Za-z0-9_./-]+$/.test(pull.remoteConfig||'')||
    !/^\/[A-Za-z0-9_./-]+$/.test(config.remoteHealthScript||''))throw Error();
 const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
 let report=null;
 try{report=await command('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8',pull.sshAlias,['node',config.remoteHealthScript,pull.remoteConfig].map(quote).join(' ')]);}catch{}
 const pullStatus=await readFile(config.pullStatusFile,'utf8').then(JSON.parse).catch(()=>null);
 let nasPullStatus=config.requireNas&&config.nasMode==='pc-pull'?await readFile(config.nasPullStatusFile,'utf8').then(JSON.parse).catch(()=>null):null;
 let pcCopy='unavailable',nasCopy='unavailable';
 async function inspect(directory){
  try{return (await command(process.execPath,[fileURLToPath(import.meta.url),'--copy-check',directory],JSON.stringify(report.latest),30000)).status;}catch{return 'unavailable';}
 }
 if(validLatest(report?.latest)){
  const copies=await Promise.all([config.requirePcCopy?inspect(pull.localDirectory):Promise.resolve('not-required'),config.requireNas&&config.nasMode==='pc-pull'?inspect(config.nasDirectory):Promise.resolve('unavailable')]);
  [pcCopy,nasCopy]=copies;
 }
 if(config.requireNas&&config.nasMode==='server-direct')({nasPullStatus,nasCopy}=directNasStatus(report));
 const current=evaluateBackupHealth({...config,report,pullStatus,nasPullStatus,pcCopy,nasCopy});
 const stateFile=path.join(root,'backup-monitor-status.json');
 const previous=await readFile(stateFile,'utf8').then(JSON.parse).catch(()=>null);
 const notification=notificationDecision(previous,current);
 const value={format:'kuvi-backup-monitor-status',version:1,...current,nasMode:config.nasMode,requirePcCopy:config.requirePcCopy,pcCopy,nasCopy:config.requireNas?nasCopy:'not-configured',notification,lastNotifiedAt:previous?.lastNotifiedAt??null,lastNotifiedCodes:previous?.lastNotifiedCodes??null};
 const part=stateFile+'.'+randomUUID()+'.part';const file=await open(part,'wx',0o600);
 try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
 await rename(part,stateFile);
 if(notification)await appendFile(path.join(root,'backup-monitor-events.jsonl'),JSON.stringify({at:value.checkedAt,ok:value.ok,codes:value.codes,event:notification})+'\n',{mode:0o600});
 console.log(JSON.stringify(value));
 process.exitCode=current.ok?0:2;
}
main().catch(()=>{console.error(JSON.stringify({ok:false,codes:['OBSERVER_EXECUTION_FAILED']}));process.exitCode=1;});
