#!/usr/bin/env node
// One controlled runtime transition. Credentials and rollback copies stay private.
import {readFile,open,rename,stat} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import dotenv from 'dotenv';
import {Client} from 'pg';
import {purposeUrl,privateDatabaseUrl} from './database-profiles.mjs';
import {names} from './database-policy.mjs';

const root=path.join(homedir(),'.config/kuvi-database');
const envFile=path.resolve('.env');
const service='kuvi-backend.service';
const property=name=>execFileSync('systemctl',['show',service,'-p',name,'--value'],{encoding:'utf8'}).trim();
async function runtimeUser(pid) {
  const text=await readFile(`/proc/${pid}/environ`);
  const entry=text.toString().split('\0').find(value=>value.startsWith('DATABASE_URL='));
  return entry?decodeURIComponent(new URL(entry.slice('DATABASE_URL='.length)).username):null;
}
function replaceUrl(text,url) {
  const pattern=/^\s*(?:export\s+)?DATABASE_URL\s*=.*$/gm;
  if([...text.matchAll(pattern)].length!==1)throw Error('AMBIGUOUS_RUNTIME_DATABASE_URL');
  const value=text.replace(pattern,()=>`DATABASE_URL=${JSON.stringify(url)}`);
  if(dotenv.parse(value).DATABASE_URL!==url)throw Error('INVALID_RUNTIME_ENVIRONMENT');
  return value;
}
async function atomicEnv(value) {
  if((await stat(root)).dev!==(await stat(path.dirname(envFile))).dev)throw Error('ATOMIC_ENVIRONMENT_REPLACEMENT_UNAVAILABLE');
  const temp=path.join(root,`runtime-${randomUUID()}.part`);
  const file=await open(temp,'wx',0o600);
  try{await file.writeFile(value);await file.sync();}finally{await file.close();}
  await rename(temp,envFile);
  const directory=await open(path.dirname(envFile),'r');
  try{await directory.sync();}finally{await directory.close();}
}
async function restartOwnedService() {
  const pid=Number(property('MainPID'));
  if(!Number.isSafeInteger(pid)||pid<2||(await stat(`/proc/${pid}`)).uid!==process.getuid())throw Error('SERVICE_PROCESS_NOT_OWNED');
  // The unit is Restart=always / KillMode=control-group. A normal SIGTERM to
  // its own supervisor allows systemd to start it with the new EnvironmentFile.
  process.kill(pid,'SIGTERM');
}
async function healthy(expectedUser) {
  const until=Date.now()+45000;
  while(Date.now()<until) {
    try {
      const pid=Number(property('MainPID'));
      if(pid>1&&await runtimeUser(pid)===expectedUser) {
        const response=await fetch('http://127.0.0.1:3000/db-health',{signal:AbortSignal.timeout(1500)});
        if(response.status===200&&(await response.json()).status==='ok')return true;
      }
    }catch{/* Wait only for this explicitly restarted unit. */}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  return false;
}
async function main() {
  if(property('Restart')!=='always'||property('KillMode')!=='control-group'||!property('EnvironmentFiles').includes(envFile))throw Error('UNSUPPORTED_SERVICE_RESTART_POLICY');
  const appUrl=await purposeUrl('app');
  const adminUrl=await privateDatabaseUrl(path.join(root,'admin.env'));
  const adminUser=decodeURIComponent(new URL(adminUrl).username);
  const client=new Client({connectionString:appUrl,connectionTimeoutMillis:8000});
  try {
    await client.connect();
    const {rows:[role]}=await client.query(`SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,
      has_schema_privilege(current_user,'public','CREATE') AS can_create_schema,
      has_database_privilege(current_user,current_database(),'CREATE') AS can_create_database_objects
      FROM pg_roles WHERE rolname=current_user`);
    if(role.name!==names.app||role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.can_create_schema||role.can_create_database_objects)throw Error('UNSAFE_RUNTIME_ROLE');
  }finally{await client.end();}
  const before=await readFile(envFile,'utf8');
  const current=dotenv.parse(before).DATABASE_URL;
  if(current!==adminUrl&&current!==appUrl)throw Error('UNEXPECTED_EXISTING_DATABASE_CONNECTION');
  if(current===appUrl) {
    // A later outage must not turn this one-time transition into an automatic
    // elevation back to the administrator account.
    if(!await healthy(names.app))throw Error('ALREADY_CONFIGURED_RUNTIME_UNHEALTHY');
    console.log(JSON.stringify({ok:true,runtimeRole:names.app,alreadyApplied:true}));return;
  }
  await atomicEnv(replaceUrl(before,appUrl));
  try {
    await restartOwnedService();
    if(!await healthy(names.app))throw Error('RUNTIME_DATABASE_HEALTH_FAILED');
    console.log(JSON.stringify({ok:true,runtimeRole:names.app,serviceRestarted:true,dbHealth:true,rollbackAvailable:true}));
  }catch{
    const now=await readFile(envFile,'utf8');
    if(dotenv.parse(now).DATABASE_URL!==appUrl)throw Error('CONCURRENT_ENVIRONMENT_CHANGE_REQUIRES_REVIEW');
    await atomicEnv(replaceUrl(now,adminUrl));
    await restartOwnedService();
    if(!await healthy(adminUser))throw Error('ROLLBACK_REQUIRES_REVIEW');
    throw Error('RUNTIME_CUTOVER_REVERTED');
  }
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.message||'')?error.message:'RUNTIME_CUTOVER_FAILED'}));process.exitCode=1;});
