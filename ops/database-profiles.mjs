import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import dotenv from 'dotenv';
import {names} from './database-policy.mjs';

export async function privateDatabaseUrl(file) {
  if(!path.isAbsolute(file))throw Error('ABSOLUTE_CREDENTIAL_PATH_REQUIRED');
  const stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw Error('PRIVATE_CREDENTIAL_FILE_REQUIRED');
  const value=dotenv.parse(await readFile(file)).DATABASE_URL;
  const url=new URL(value);
  if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('INVALID_DATABASE_PROFILE');
  return value;
}
export async function databaseProfiles(file=process.env.KUVI_DATABASE_PROFILES||path.join(homedir(),'.config/kuvi-database/profiles.json')) {
  const stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw Error('PRIVATE_PROFILE_REQUIRED');
  const value=JSON.parse(await readFile(file,'utf8'));
  if(value.format!=='kuvi-database-profiles'||value.version!==1||value.owner!==names.owner||value.restoreOwner!==names.restoreOwner)throw Error('INVALID_DATABASE_PROFILES');
  return value;
}
export async function purposeUrl(purpose,profiles) {
  profiles ??= await databaseProfiles();
  if(!['app','backup','migration','restore'].includes(purpose))throw Error('INVALID_DATABASE_PURPOSE');
  const value=await privateDatabaseUrl(profiles[purpose+'EnvFile']);
  if(decodeURIComponent(new URL(value).username)!==names[purpose])throw Error('DATABASE_PURPOSE_MISMATCH');
  return value;
}
