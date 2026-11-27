#!/usr/bin/env node
// Existing integration suites run as the owner of a NEW disposable database,
// never as the application's runtime account or inside the live database.
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {Client} from 'pg';
import {purposeUrl} from './database-profiles.mjs';
import {identifier,literal,names} from './database-policy.mjs';

const allowed=['sessions','clinical-access','appointments','medications','physicians','documents'];
async function main() {
  const suite=process.argv[2];
  if(!allowed.includes(suite)||process.argv.length!==3)throw Error('INVALID_TEST_SUITE');
  const restoreUrl=await purposeUrl('restore');
  const url=new URL(restoreUrl), login=decodeURIComponent(url.username);
  if(decodeURIComponent(url.pathname.slice(1))!=='postgres')throw Error('MAINTENANCE_DATABASE_REQUIRED');
  const target='kuvi_integration_test_'+randomUUID().replaceAll('-','');
  const client=new Client({connectionString:restoreUrl,connectionTimeoutMillis:8000});
  let created=false;
  try {
    await client.connect();
    await client.query(`CREATE DATABASE ${identifier(target)} OWNER ${identifier(names.restoreOwner)}`);created=true;
    await client.query(`ALTER ROLE ${identifier(login)} IN DATABASE ${identifier(target)} SET role=${literal(names.restoreOwner)}`);
    await client.query(`SET ROLE ${identifier(names.restoreOwner)}`);
    await client.query(`REVOKE ALL ON DATABASE ${identifier(target)} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${identifier(target)} TO ${identifier(login)}`);
    await client.query('RESET ROLE');
    url.pathname='/'+target;
    const testUrl=url.toString();
    const secret=randomBytes(32).toString('hex');
    const env={...process.env,DATABASE_URL:testUrl,JWT_SECRET:secret,APP_ENV:'test',LOG_LEVEL:'silent'};
    const generated=spawnSync('node_modules/.bin/prisma',['generate'],{env,encoding:'utf8',timeout:60000});
    if(generated.status!==0)throw Error('TEST_CLIENT_GENERATION_FAILED');
    const child=spawn(process.execPath,[`tests/run-${suite}.mjs`],{
      env,
      stdio:['ignore','pipe','pipe']});
    let output='';
    const collect=bytes=>{output+=bytes.toString('utf8');if(output.length>4*1024*1024)child.kill();};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    const timer=setTimeout(()=>child.kill(),10*60*1000);
    let code;
    try{code=await new Promise(resolve=>{child.on('error',()=>resolve(1));child.on('close',resolve);});}
    finally{clearTimeout(timer);}
    output=output.replaceAll(testUrl,'[isolated database]').replaceAll(decodeURIComponent(url.password),'[redacted]').replaceAll(secret,'[redacted]');
    process.stdout.write(output);
    if(code!==0)throw Error('ISOLATED_SUITE_FAILED');
    console.log(JSON.stringify({ok:true,suite,isolatedDatabase:true}));
  }finally{
    if(created) {
      await client.query(`SET ROLE ${identifier(names.restoreOwner)}`);
      await client.query(`DROP DATABASE ${identifier(target)}`);
    }
    await client.end();
  }
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.message||'')?error.message:'ISOLATED_TEST_FAILED'}));process.exitCode=1;});
