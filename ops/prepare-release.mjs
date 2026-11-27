#!/usr/bin/env node
// Runs only as the operator. Builds a tracked Git snapshot, never a working .env.
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,open,readFile,readdir,cp,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {homedir} from 'node:os';
import {pipeline} from 'node:stream/promises';
import {appliedMigrations,migrationSignature} from './release-schema.mjs';
const repository='/home/miguel/kuvi-api';
const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8'}).trim();
async function main(){
  if(process.getuid()===0||process.argv.length!==2)throw Error('RUN_AS_OPERATOR_WITHOUT_ARGUMENTS');
  if(git('diff','--name-only')||git('diff','--cached','--name-only'))throw Error('TRACKED_WORKTREE_CHANGES_REQUIRE_COMMIT');
  const commit=git('rev-parse','HEAD');
  const id=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')+'-'+commit.slice(0,12);
  const base=path.join(homedir(),'.local/share/kuvi-deploy');
  await mkdir(base,{recursive:true,mode:0o700});
  const bundle=path.join(base,id);await mkdir(bundle,{mode:0o700});
  const source=path.join(bundle,'source');await mkdir(source,{mode:0o700});
  const log=await open(path.join(bundle,'prepare.log'),'wx',0o600);
  const env={PATH:process.env.PATH,HOME:homedir(),LANG:'C.UTF-8',CI:'1',
    DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
    JWT_SECRET:'synthetic-build-secret-not-for-runtime-use',LOG_LEVEL:'silent'};
  async function run(program,args){
    const child=spawn(program,args,{cwd:source,env,stdio:['ignore',log.fd,log.fd]});
    const timer=setTimeout(()=>child.kill('SIGTERM'),10*60*1000);
    try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});if(code!==0)throw Error('RELEASE_BUILD_OR_TEST_FAILED');}
    finally{clearTimeout(timer);}
  }
  try{
    const archive=spawn('git',['-C',repository,'archive','--format=tar',commit],{stdio:['ignore','pipe',log.fd]});
    const extract=spawn('tar',['-x','-C',source],{stdio:['pipe',log.fd,log.fd]});
    const archiveExit=new Promise((resolve,reject)=>{archive.once('error',reject);archive.once('close',resolve);});
    const extractExit=new Promise((resolve,reject)=>{extract.once('error',reject);extract.once('close',resolve);});
    await pipeline(archive.stdout,extract.stdin);
    if((await archiveExit)!==0||(await extractExit)!==0)throw Error('SOURCE_SNAPSHOT_FAILED');
    console.log(JSON.stringify({phase:'dependencies',release:id}));
    await run('/usr/bin/npm',['ci','--ignore-scripts','--no-audit','--no-fund']);
    await run('/usr/bin/npm',['run','prisma:generate']);
    console.log(JSON.stringify({phase:'build-and-tests'}));
    await run('/usr/bin/npm',['test']);
    await run('/usr/bin/npm',['run','test:backups']);
    const migrations=[];
    for(const name of (await readdir(path.join(source,'prisma/migrations'),{withFileTypes:true})).filter(x=>x.isDirectory()).map(x=>x.name).sort()){
      const sql=await readFile(path.join(source,'prisma/migrations',name,'migration.sql'));
      migrations.push({name,checksum:createHash('sha256').update(sql).digest('hex')});
    }
    const schemaSignature=migrationSignature(migrations);
    if(schemaSignature!==migrationSignature(await appliedMigrations()))throw Error('MIGRATIONS_REQUIRE_SEPARATE_REVIEW');
    const runtime=path.join(bundle,'runtime');await mkdir(runtime,{mode:0o700});
    for(const name of ['dist','node_modules','package.json'])await cp(path.join(source,name),path.join(runtime,name),{recursive:true,verbatimSymlinks:true});
    const tree=JSON.parse(execFileSync('/usr/bin/python3',[path.join(repository,'ops/deploy-runtime.py'),'--fingerprint',runtime],{encoding:'utf8'}));
    const manifest={format:'kuvi-runtime-release',version:1,id,commit,createdAt:new Date().toISOString(),node:process.version,schemaSignature,tree,checks:['npm-ci-locked','prisma-generate','general-tests','backup-tests','migration-checksums']};
    await writeFile(path.join(bundle,'release.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
    await log.sync();
    console.log(JSON.stringify({ok:true,release:id,bundle,commit,testsPassed:true,migrationsMatch:true}));
  }finally{await log.close();}
}
main().catch(()=>{console.error('RELEASE_PREPARATION_FAILED: inspect the private prepare.log; no deployment was attempted.');process.exitCode=1;});
