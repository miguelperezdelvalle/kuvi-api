#!/usr/bin/env node
// Migration metadata only; no clinical rows or credential values are returned.
import {Client} from 'pg';
import {createHash} from 'node:crypto';
import {purposeUrl} from './database-profiles.mjs';
export function migrationSignature(rows) {
  return createHash('sha256').update(JSON.stringify(rows.map(r=>({name:r.name,checksum:r.checksum})).sort((a,b)=>a.name.localeCompare(b.name,'en')))).digest('hex');
}
export async function appliedMigrations() {
  const client=new Client({connectionString:await purposeUrl('backup'),connectionTimeoutMillis:8000});
  try {
    await client.connect();
    await client.query('SET statement_timeout=8000');
    const {rows}=await client.query('SELECT migration_name AS name,checksum,finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL ORDER BY migration_name');
    if(rows.some(r=>!r.finished_at))throw Error('UNFINISHED_MIGRATION');
    return rows.map(({name,checksum})=>({name,checksum}));
  }finally{await client.end();}
}
if(process.argv[1]?.endsWith('/release-schema.mjs')) {
  try{
    const expected=process.argv[2];
    if(!/^[a-f0-9]{64}$/.test(expected||'')||process.argv.length!==3)throw Error('EXPECTED_SCHEMA_SIGNATURE_REQUIRED');
    if(migrationSignature(await appliedMigrations())!==expected)throw Error('DATABASE_MIGRATIONS_CHANGED');
    console.log(JSON.stringify({ok:true,schemaMatches:true}));
  }catch{console.error('DATABASE_MIGRATION_CHECK_FAILED');process.exitCode=1;}
}
