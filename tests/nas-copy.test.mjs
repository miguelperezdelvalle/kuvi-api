import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {copyBackupsToNas,requireNasMount,validateNasMount} from '../ops/nas-copy-core.mjs';
const filename='kuvi-db-20261127T120000Z-1234abcd.dump.gpg';
async function fixture(run){
 const root=await mkdtemp(path.join(tmpdir(),'kuvi-nas-copy-test-'));
 const source=path.join(root,'source'),target=path.join(root,'nas');
 await mkdir(source,{mode:0o700});await mkdir(target,{mode:0o700});
 const bytes=Buffer.from('synthetic ciphertext only');
 const manifest={format:'kuvi-postgres-backup',version:1,filename,createdAt:'2026-11-27T12:00:00Z',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,databaseMajor:16,sourceIdentity:'b'.repeat(64)};
 await writeFile(path.join(source,filename),bytes);
 await writeFile(path.join(source,filename+'.json'),JSON.stringify(manifest));
 try{await run({root,source,target,bytes,manifest,config:{outputDir:source}});}finally{await rm(root,{recursive:true});}
}
test('copy, read-back and receipt; repeated copy does not duplicate files',()=>fixture(async v=>{
 assert.equal((await copyBackupsToNas(v.config,v.target)).copied,1);
 assert.deepEqual(await readFile(path.join(v.target,filename)),v.bytes);
 assert.equal(JSON.parse(await readFile(path.join(v.source,filename+'.receipt.json'),'utf8')).sha256,v.manifest.sha256);
 assert.equal((await copyBackupsToNas(v.config,v.target)).copied,0);
 assert.equal((await readdir(v.target)).length,2);
}));
test('existing content conflict is preserved and receives no acknowledgement',()=>fixture(async v=>{
 await writeFile(path.join(v.target,filename),'unrelated bytes');
 await assert.rejects(copyBackupsToNas(v.config,v.target),/NAS_COPY_CONFLICT/);
 assert.equal(await readFile(path.join(v.target,filename),'utf8'),'unrelated bytes');
 await assert.rejects(lstat(path.join(v.source,filename+'.receipt.json')),{code:'ENOENT'});
}));
test('interrupted copy removes only its temporary file and sends no receipt',()=>fixture(async v=>{
 await assert.rejects(copyBackupsToNas(v.config,v.target,{copy:async(_,part)=>{await writeFile(part,'partial');throw Error('synthetic interruption');}}));
 assert.deepEqual(await readdir(v.target),[]);
 await assert.rejects(lstat(path.join(v.source,filename+'.receipt.json')),{code:'ENOENT'});
}));
test('corrupt read-back is rejected before publishing or acknowledging',()=>fixture(async v=>{
 await assert.rejects(copyBackupsToNas(v.config,v.target,{copy:async(_,part)=>{await writeFile(part,'corrupt');}}),/NAS_CHECKSUM_MISMATCH/);
 assert.deepEqual(await readdir(v.target),[]);
}));
test('existing symbolic link cannot redirect the destination',()=>fixture(async v=>{
 await symlink(path.join(v.source,filename),path.join(v.target,filename));
 await assert.rejects(copyBackupsToNas(v.config,v.target),/NAS_COPY_CONFLICT/);
 assert.deepEqual(await readFile(path.join(v.source,filename)),v.bytes);
}));
test('mismatched manifest is preserved',()=>fixture(async v=>{
 await writeFile(path.join(v.target,filename),v.bytes);
 const conflict={...v.manifest,sourceIdentity:'c'.repeat(64)};
 await writeFile(path.join(v.target,filename+'.json'),JSON.stringify(conflict));
 await assert.rejects(copyBackupsToNas(v.config,v.target),/NAS_MANIFEST_CONFLICT/);
 assert.equal(JSON.parse(await readFile(path.join(v.target,filename+'.json'),'utf8')).sourceIdentity,conflict.sourceIdentity);
}));
test('mount guard refuses arbitrary folders before network or writes',async()=>{
 await assert.rejects(requireNasMount({mountPoint:'/tmp',host:'192.168.1.1',share:'backup'}),/INVALID_NAS_CONFIG/);
});
test('mount validation selects encrypted CIFS beneath an automount entry',()=>{
 const config={mountPoint:'/mnt/kuvi-nas',host:'192.168.1.50',share:'backup'};
 const auto={target:config.mountPoint,fstype:'autofs',source:'systemd-1',options:'rw'};
 const cifs={target:config.mountPoint,fstype:'cifs',source:'//192.168.1.50/backup',options:'rw,seal,noexec,nosuid,nodev,cache=none'};
 assert.doesNotThrow(()=>validateNasMount({filesystems:[auto,cifs]},config));
 assert.throws(()=>validateNasMount({filesystems:[auto]},config),/EXPECTED_ENCRYPTED_NAS_MOUNT_REQUIRED/);
 assert.throws(()=>validateNasMount({filesystems:[{...cifs,source:'//192.168.1.51/backup'}]},config),/EXPECTED_ENCRYPTED_NAS_MOUNT_REQUIRED/);
 assert.throws(()=>validateNasMount({filesystems:[{...cifs,options:'rw,noexec,nosuid,nodev,cache=none'}]},config),/EXPECTED_ENCRYPTED_NAS_MOUNT_REQUIRED/);
});
