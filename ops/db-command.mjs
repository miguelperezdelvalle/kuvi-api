#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {Client} from 'pg';
import {purposeUrl} from './database-profiles.mjs';
import {assertKnownSchema,grantTablePolicy} from './database-policy.mjs';

const commands={
  'migrate-deploy':['node_modules/.bin/prisma',['migrate','deploy']],
  'migrate-status':['node_modules/.bin/prisma',['migrate','status']],
  'doctor-onboard':[process.execPath,['dist/modules/clinical-access/doctor-onboarding-cli.js']],
  'seed':['node_modules/.bin/tsx',['prisma/seed.ts']],
};
async function main() {
  const action=process.argv[2];
  if(!Object.hasOwn(commands,action)||process.argv.length!==3)throw Error('INVALID_OPERATOR_COMMAND');
  const url=await purposeUrl('migration');
  const [program,args]=commands[action];
  const child=spawn(program,args,{env:{...process.env,DATABASE_URL:url},stdio:['inherit','pipe','pipe']});
  let output='';
  const capture=bytes=>{output+=bytes.toString('utf8');if(output.length>1024*1024)child.kill();};
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  const timer=setTimeout(()=>child.kill(),30*60*1000);
  let code;
  try{code=await new Promise(resolve=>{child.on('error',()=>resolve(1));child.on('close',resolve);});}
  finally{clearTimeout(timer);}
  if(code!==0)throw Error('OPERATOR_COMMAND_FAILED');
  if(action==='migrate-deploy') {
    const client=new Client({connectionString:url});
    try{
      await client.connect();await client.query('BEGIN');
      try{await assertKnownSchema(client);await grantTablePolicy(client);await client.query('COMMIT');}
      catch(error){await client.query('ROLLBACK');throw error;}
    }
    finally{await client.end();}
  }
  if(action==='doctor-onboard') {
    const value=JSON.parse(output.trim());
    if(value.result!=='OK'||!['create','approve','revoke','created-approved'].includes(value.action)||
      typeof value.userId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(value.userId))throw Error('INVALID_OPERATOR_RESULT');
    console.log(JSON.stringify({result:'OK',userId:value.userId,action:value.action}));
  }else console.log(JSON.stringify({ok:true,action}));
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.message||'')?error.message:'DATABASE_COMMAND_FAILED'}));process.exitCode=1;});
