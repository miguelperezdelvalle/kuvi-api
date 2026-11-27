// Opt-in operational test. Uses read-only DB metadata and synthetic fake dumps.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadConfig,runBackup} from '../ops/backup-core.mjs';

if (!process.argv[2]) throw Error('An explicit private backup config is required');
const configFile=path.resolve(process.argv[2]);
const base=await loadConfig(configFile);
const root=await mkdtemp(path.join(path.dirname(base.gpgHome),'failure-check-'));
let passed=0;
try {
  const cfg={...base,outputDir:root,timeoutMs:5000};
  const fake=path.join(root,'failed-pg_dump');
  await writeFile(fake,'#!/bin/sh\necho "pg_dump (PostgreSQL) 99.0"\n',{mode:0o700});
  await assert.rejects(runBackup({...cfg,pgDump:fake}),e=>e.code==='PG_CLIENT_VERSION_MISMATCH');passed++;
  await writeFile(fake,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.15"; exit 0; fi\nprintf "Synthetic partial dump"\nexit 1\n',{mode:0o700});
  await assert.rejects(runBackup({...cfg,pgDump:fake}));
  assert.equal((await readdir(root)).filter(x=>x.endsWith('.gpg')||x.endsWith('.part')).length,0);passed++;
  await writeFile(fake,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.15"; exit 0; fi\nhead -c 8192 /dev/urandom\n',{mode:0o700});
  await assert.rejects(runBackup({...cfg,pgDump:fake,maxArchiveBytes:1024}));
  assert.equal((await readdir(root)).filter(x=>x.endsWith('.gpg')||x.endsWith('.part')).length,0);passed++;
  const script=fileURLToPath(new URL('../ops/backup.mjs',import.meta.url));
  const code=`const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,[${JSON.stringify(script)},'run',${JSON.stringify(configFile)}],{stdio:'ignore'});process.exit(r.status===75?0:1);`;
  const result=spawnSync('flock',['--exclusive',path.join(base.outputDir,'.backup.lock'),process.execPath,'-e',code],{timeout:10000});
  assert.equal(result.status,0);passed++;
  console.log(JSON.stringify({ok:true,failureScenariosPassed:passed,partialSnapshotsPublished:false}));
} finally {
  // mkdtemp produced this exact, private test directory; no application path
  // or arbitrary user argument is recursively removed.
  await rm(root,{recursive:true});
}
