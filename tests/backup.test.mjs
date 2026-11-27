import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, writeFile, readFile, symlink, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BackupError, validateManifest, postgresEnvironment, privateDirectory,
  readManifest, fileDigest, acknowledge, listBackups, pruneBackups, verifyRestore } from '../ops/backup-core.mjs';

const filename = 'kuvi-db-20261125T120000Z-1234abcd.dump.gpg';
const valid = {format:'kuvi-postgres-backup',version:1,filename,
  sha256:'a'.repeat(64),bytes:100,databaseMajor:16,sourceIdentity:'b'.repeat(64),createdAt:'2026-11-25T12:00:00Z'};
test('manifest rejects unsafe paths, malformed hashes, empty or excessive bytes and unsupported formats', () => {
  assert.equal(validateManifest(valid), valid);
  for (const change of [{filename:'../data'}, {filename:'/data'}, {sha256:'*'}, {bytes:0},
    {bytes:21*1024**3}, {version:99}, {createdAt:'invalid'}, {sourceIdentity:'private-host'}]) {
    assert.throws(() => validateManifest({...valid,...change}), BackupError);
  }
});
test('PostgreSQL secrets use environment rather than command arguments and Prisma parameters are not passed to libpq', () => {
  const env = postgresEnvironment('postgresql://synthetic:public%40test@localhost:5432/synthetic_database?schema=private&sslmode=require');
  assert.equal(env.PGUSER,'synthetic'); assert.equal(env.PGPASSWORD,'public@test');
  assert.equal(env.PGDATABASE,'synthetic_database'); assert.equal(env.PGSSLMODE,'require');
  assert.ok(env.PGOPTIONS.includes('default_transaction_read_only=on'));
  assert.throws(() => postgresEnvironment('https://example.test'), BackupError);
});
test('backup directory must be private, owned and not a symbolic link', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'kuvi_backup_unit_'));
  try {
    await chmod(root,0o700); assert.equal(await privateDirectory(root), root);
    await chmod(root,0o755); await assert.rejects(privateDirectory(root),BackupError);
    await chmod(root,0o700); const link = `${root}-link`;
    await symlink(root,link);
    try { await assert.rejects(privateDirectory(link),BackupError); }
    finally { await rm(link); }
  } finally { await rm(root,{recursive:true}); }
});
test('inventory verifies complete ciphertext, preserves unknown files and rejects corruption before acknowledging', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'kuvi_backup_unit_'));
  try {
    const target = path.join(root,filename);
    await writeFile(target, 'Synthetic encrypted bytes', {mode:0o600});
    const digest = await fileDigest(target);
    const manifest = {...valid,...digest};
    await writeFile(`${target}.json`,JSON.stringify(manifest));
    await writeFile(path.join(root,'unrelated.old'),'keep');
    const config={outputDir:root};
    assert.deepEqual(await listBackups(config),[manifest]);
    await assert.rejects(acknowledge(config,filename,'c'.repeat(64)),BackupError);
    await acknowledge(config,filename,digest.sha256);
    assert.equal(JSON.parse(await readFile(`${target}.receipt.json`,'utf8')).sha256,digest.sha256);
    await writeFile(target,'Altered');
    await assert.rejects(readManifest(config,filename),BackupError);
    await assert.rejects(listBackups(config),BackupError);
    assert.equal(await readFile(path.join(root,'unrelated.old'),'utf8'),'keep');
  } finally { await rm(root,{recursive:true}); }
});
test('retention keeps the latest seven and every unacknowledged archive, touching no foreign files', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'kuvi_backup_unit_'));
  try {
    const config={outputDir:root};
    for(let i=1;i<=10;i++) {
      const day=String(i).padStart(2,'0');
      const name=`kuvi-db-202610${day}T120000Z-1234abcd.dump.gpg`;
      const target=path.join(root,name);
      await writeFile(target,`Synthetic ciphertext ${i}`);
      const digest=await fileDigest(target);
      await writeFile(`${target}.json`,JSON.stringify({...valid,...digest,filename:name,createdAt:`2026-10-${day}T12:00:00Z`}));
      if(i!==2) await acknowledge(config,name,digest.sha256);
    }
    await writeFile(path.join(root,'legacy-backup.sql'),'keep');
    assert.equal(await pruneBackups(config,new Date('2026-11-25T12:00:00Z')),2);
    const remaining=await listBackups(config);
    assert.equal(remaining.length,8);
    assert.ok(remaining.some(x=>x.filename.includes('20261002')));
    assert.equal(await readFile(path.join(root,'legacy-backup.sql'),'utf8'),'keep');
  } finally { await rm(root,{recursive:true}); }
});
test('restore checker rejects arbitrary paths or hashes before connecting to a database', async () => {
  for (const [name, hash] of [['../../production.dump','a'.repeat(64)],
      ['restore-check-00000000-0000-0000-0000-000000000000.dump','*']]) {
    await assert.rejects(verifyRestore({},name,hash),BackupError);
  }
});
