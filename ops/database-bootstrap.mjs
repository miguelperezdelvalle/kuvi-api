#!/usr/bin/env node
// Operator-only provisioning. Keep the administrator credential outside Git.
import {readFile,writeFile,open,mkdir,lstat,rename} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';
import dotenv from 'dotenv';
import {Client} from 'pg';
import {names,identifier,literal,scramVerifier,connectionFor,applyDatabasePolicy} from './database-policy.mjs';

const root=process.argv[3]||path.join(homedir(),'.config/kuvi-database');
async function privateWrite(file,text) {
  const fd=await open(file,'wx',0o600);
  try{await fd.writeFile(text);await fd.sync();}finally{await fd.close();}
}
async function main() {
  if(!['prepare','apply','audit'].includes(process.argv[2])||!root||!path.isAbsolute(root)) throw Error('INVALID_ARGUMENTS');
  await mkdir(root,{recursive:true,mode:0o700});
  const stat=await lstat(root);
  if(stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0) throw Error('PRIVATE_DIRECTORY_REQUIRED');
  const sourcePath=path.resolve(process.argv[4]||'.env');
  const adminFile=path.join(root,'admin.env');
  let original;
  try{original=dotenv.parse(await readFile(process.argv[2]==='audit'?path.join(root,'app.env'):adminFile)).DATABASE_URL;}
  catch(error){
    if(error.code!=='ENOENT'||process.argv[2]!=='prepare')throw error;
    original=dotenv.parse(await readFile(sourcePath)).DATABASE_URL;
    await privateWrite(adminFile,'DATABASE_URL='+JSON.stringify(original)+'\n');
    await privateWrite(path.join(root,'application.before-permissions.env'),await readFile(sourcePath));
  }
  const client=new Client({connectionString:original,connectionTimeoutMillis:8000,application_name:'kuvi-role-provision'});
  try {
    await client.connect();
    if(process.argv[2]==='prepare') {
      const files={};
      const credentials={};
      for(const purpose of ['app','backup','migration','restore']) {
        const file=path.join(root,`${purpose}.env`);files[purpose]=file;
        try{credentials[purpose]=dotenv.parse(await readFile(file)).DATABASE_URL;}
        catch(error){
          if(error.code!=='ENOENT')throw error;
          const password=randomBytes(32).toString('hex');
          const url=connectionFor(original,names[purpose],password,purpose==='restore'?'postgres':undefined);
          if(purpose==='restore') {const u=new URL(url);u.searchParams.delete('schema');credentials[purpose]=u.toString();}
          else credentials[purpose]=url;
          await privateWrite(file,'DATABASE_URL='+JSON.stringify(credentials[purpose])+'\n');
        }
      }
      await client.query('BEGIN');
      try {
        for(const key of ['owner','restoreOwner','app','backup','migration','restore']) {
          const {rows}=await client.query('SELECT rolsuper,rolcanlogin FROM pg_roles WHERE rolname=$1',[names[key]]);
          if(rows.length) throw Error('ROLE_ALREADY_EXISTS_REQUIRES_AUDIT');
          const flags=key==='owner'||key==='restoreOwner'?'NOLOGIN':key==='restore'?'LOGIN CREATEDB':'LOGIN NOCREATEDB';
          const purpose=credentials[key];
          const password=purpose?` PASSWORD ${literal(scramVerifier(decodeURIComponent(new URL(purpose).password)))}`:'';
          await client.query(`CREATE ROLE ${identifier(names[key])} ${flags} NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS${password}`);
        }
        await client.query(`GRANT ${identifier(names.owner)} TO ${identifier(names.migration)} WITH INHERIT FALSE, SET TRUE`);
        await client.query(`GRANT ${identifier(names.restoreOwner)} TO ${identifier(names.restore)} WITH INHERIT FALSE, SET TRUE`);
        await client.query(`ALTER ROLE ${identifier(names.migration)} SET role=${literal(names.owner)}`);
        await client.query(`ALTER ROLE ${identifier(names.backup)} SET default_transaction_read_only=on`);
        await client.query(`ALTER ROLE ${identifier(names.backup)} CONNECTION LIMIT 3`);
        await client.query(`ALTER ROLE ${identifier(names.app)} CONNECTION LIMIT 30`);
        await client.query(`ALTER ROLE ${identifier(names.restore)} CONNECTION LIMIT 6`);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}
      const profiles={format:'kuvi-database-profiles',version:1,...Object.fromEntries(Object.entries(files).map(([k,v])=>[k+'EnvFile',v])),owner:names.owner,restoreOwner:names.restoreOwner};
      await privateWrite(path.join(root,'profiles.json'),JSON.stringify(profiles)+'\n');
      console.log(JSON.stringify({ok:true,rolesPrepared:true,credentialsPrinted:false}));
    } else if(process.argv[2]==='apply') {
      await applyDatabasePolicy(client);
      console.log(JSON.stringify({ok:true,policyApplied:true,clinicalRowsChanged:false}));
    } else {
      const {rows}=await client.query(`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,[Object.values(names)]);
      console.log(JSON.stringify({ok:true,roles:rows}));
    }
  }finally{await client.end();}
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.message||'')?error.message:'ROLE_OPERATION_FAILED'}));process.exitCode=1;});
