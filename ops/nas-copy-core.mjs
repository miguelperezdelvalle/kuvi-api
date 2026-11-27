import {copyFile,lstat,open,rename,unlink,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {listBackups,fileDigest,acknowledge,validateManifest,privateDirectory} from './backup-core.mjs';
export function validateNasMount(result,config){
 const mount=result.filesystems?.find(m=>m.target===config.mountPoint&&m.fstype==='cifs');
 const options=mount?.options?.split(',')??[];
 if(mount?.source!==`//${config.host}/${config.share}`||!['seal','noexec','nosuid','nodev','cache=none'].every(x=>options.includes(x)))throw Error('EXPECTED_ENCRYPTED_NAS_MOUNT_REQUIRED');
}
export async function requireNasMount(config){
 if(config.mountPoint!=='/mnt/kuvi-nas'||!/^\d{1,3}(\.\d{1,3}){3}$/.test(config.host||'')||!/^[A-Za-z0-9_-]{1,64}$/.test(config.share||''))throw Error('INVALID_NAS_CONFIG');
 await readdir(config.mountPoint); // Trigger automount; never copy into the underlying local directory.
 const result=JSON.parse(execFileSync('/usr/bin/findmnt',['--json','--types','cifs','--target',config.mountPoint,'--output','TARGET,FSTYPE,SOURCE,OPTIONS'],{encoding:'utf8',timeout:10000}));
 validateNasMount(result,config);
 const stat=await lstat(config.mountPoint);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('PRIVATE_NAS_MOUNT_REQUIRED');
}
export async function copyBackupsToNas(config,directory,{copy=copyFile}={}){
 const targetDir=await privateDirectory(directory);
 const backups=await listBackups(config);
 if(!backups.length)throw Error('NO_BACKUPS_TO_COPY');
 let copied=0;
 for(const manifest of backups){
  const target=path.join(targetDir,manifest.filename),source=path.join(config.outputDir,manifest.filename);
  const existing=await lstat(target).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
  if(existing){
   if(!existing.isFile()||existing.isSymbolicLink())throw Error('NAS_COPY_CONFLICT');
   const actual=await fileDigest(target);
   if(actual.sha256!==manifest.sha256||actual.bytes!==manifest.bytes)throw Error('NAS_COPY_CONFLICT');
  }else{
   const part=target+'.'+randomUUID()+'.part';
   try{
    await copy(source,part);
    const fd=await open(part,'r+');try{await fd.sync();}finally{await fd.close();}
    const actual=await fileDigest(part);
    if(actual.sha256!==manifest.sha256||actual.bytes!==manifest.bytes)throw Error('NAS_CHECKSUM_MISMATCH');
    await rename(part,target);copied++;
   }finally{await unlink(part).catch(()=>{});}
  }
  const meta=target+'.json';
  const metaStat=await lstat(meta).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
  if(metaStat){
   if(!metaStat.isFile()||metaStat.isSymbolicLink())throw Error('NAS_MANIFEST_CONFLICT');
   const stored=validateManifest(JSON.parse(await readFile(meta,'utf8')));
   for(const key of ['filename','sha256','bytes','sourceIdentity','createdAt'])if(stored[key]!==manifest[key])throw Error('NAS_MANIFEST_CONFLICT');
  }else{
   const part=meta+'.'+randomUUID()+'.part',fd=await open(part,'wx',0o600);
   try{await fd.writeFile(JSON.stringify(manifest)+'\n');await fd.sync();}finally{await fd.close();}
   try{await rename(part,meta);}finally{await unlink(part).catch(()=>{});}
  }
  // Confirm only after bytes on the NAS have been flushed and read back.
  await acknowledge(config,manifest.filename,manifest.sha256);
 }
 return {verified:backups.length,copied,latest:backups.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0]};
}
