import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Client} from 'pg';
import {databaseProfiles,privateDatabaseUrl,purposeUrl} from '../ops/database-profiles.mjs';
import {names,identifier,applyDatabasePolicy} from '../ops/database-policy.mjs';

const profiles=await databaseProfiles();
const root=path.dirname(profiles.appEnvFile);
const adminUrl=await privateDatabaseUrl(path.join(root,'admin.env'));
const admin=new Client({connectionString:adminUrl});
const target='kuvi_permissions_test_'+randomUUID().replaceAll('-','');
const temp=await mkdtemp(path.join(root,'test-'));
let created=false;
const urlFor=(value)=>{const url=new URL(value);url.pathname='/'+target;url.searchParams.set('schema','public');return url.toString();};
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${identifier(target)} OWNER ${identifier(names.owner)}`);created=true;
  await admin.query(`GRANT CONNECT ON DATABASE ${identifier(target)} TO ${identifier(names.migration)}`);
  const migrationUrl=urlFor(await purposeUrl('migration'));
  const appUrl=urlFor(await purposeUrl('app'));
  const backupUrl=urlFor(await purposeUrl('backup'));
  const env={...process.env,DATABASE_URL:migrationUrl,JWT_SECRET:randomBytes(32).toString('hex'),APP_ENV:'test',LOG_LEVEL:'silent'};
  for(const [command,args] of [['node_modules/.bin/prisma',['generate']],['node_modules/.bin/prisma',['migrate','deploy']],['node_modules/.bin/tsc',[]]]) {
    const result=spawnSync(command,args,{env,encoding:'utf8',timeout:120000});
    if(result.status!==0)throw Error('PERMISSION_TEST_BUILD_OR_MIGRATION_FAILED');
  }
  const testAdmin=new Client({connectionString:urlFor(adminUrl)});
  try{await testAdmin.connect();await applyDatabasePolicy(testAdmin);}
  finally{await testAdmin.end();}
  const testMigrationFile=path.join(temp,'migration.env');
  await writeFile(testMigrationFile,'DATABASE_URL='+JSON.stringify(migrationUrl)+'\n',{mode:0o600});
  const testProfiles=path.join(temp,'profiles.json');
  await writeFile(testProfiles,JSON.stringify({...profiles,migrationEnvFile:testMigrationFile}),{mode:0o600});
  const context={target,appUrl,backupUrl,migrationUrl,jwt:env.JWT_SECRET,testProfiles};
  const contextFile=path.join(temp,'context.json');
  await writeFile(contextFile,JSON.stringify(context),{mode:0o600});
  const result=spawnSync(process.execPath,['--test','tests/database-permissions.test.mjs'],{
    env:{...env,DATABASE_URL:appUrl,KUVI_PRIVILEGE_TEST_CONTEXT:contextFile},encoding:'utf8',timeout:180000});
  let output=(result.stdout||'')+(result.stderr||'');
  for(const value of [appUrl,backupUrl,migrationUrl]) {
    output=output.replaceAll(value,'[private test connection]').replaceAll(decodeURIComponent(new URL(value).password),'[redacted]');
  }
  output=output.replaceAll(env.JWT_SECRET,'[redacted]');
  process.stdout.write(output);
  if(result.status!==0)throw Error('PERMISSION_INTEGRATION_FAILED');
  console.log(JSON.stringify({ok:true,isolatedPermissionMatrix:true,runtimeSuperuser:false}));
}catch(error){console.error(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.message||'')?error.message:'PERMISSION_TEST_FAILED'}));process.exitCode=1;}
finally {
  if(created)await admin.query(`DROP DATABASE ${identifier(target)}`);
  await admin.end();
  await rm(temp,{recursive:true});
}
