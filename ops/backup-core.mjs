import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readFile, mkdir, lstat, realpath, readdir, rename, unlink, statfs } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { privateDatabaseUrl } from './database-profiles.mjs';
import { names, identifier } from './database-policy.mjs';

export class BackupError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const backupName = /^kuvi-db-\d{8}T\d{6}Z-[a-f0-9]{8}\.dump\.gpg$/;
export const hashPattern = /^[a-f0-9]{64}$/;
const fail = code => { throw new BackupError(code); };
export function validateManifest(value) {
  if (!value || value.format !== 'kuvi-postgres-backup' || value.version !== 1 ||
      !backupName.test(value.filename) || !hashPattern.test(value.sha256) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 20 * 1024 ** 3 ||
      !Number.isInteger(value.databaseMajor) || value.databaseMajor < 12 || value.databaseMajor > 30 ||
      !hashPattern.test(value.sourceIdentity) || typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt))) fail('INVALID_MANIFEST');
  return value;
}
export async function privateDirectory(directory) {
  if (!path.isAbsolute(directory)) fail('ABSOLUTE_DIRECTORY_REQUIRED');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0) fail('PRIVATE_DIRECTORY_REQUIRED');
  return realpath(directory);
}
export function postgresEnvironment(raw) {
  let url;
  try { url = new URL(raw); } catch { fail('INVALID_DATABASE_CONFIG'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
      !url.username || url.pathname.length < 2) fail('INVALID_DATABASE_CONFIG');
  return { ...process.env, PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get('sslmode') || 'prefer', PGCONNECT_TIMEOUT: '8',
    PGAPPNAME: 'kuvi-encrypted-backup',
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=1800000' };
}
export async function loadConfig(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0) fail('PRIVATE_CONFIG_REQUIRED');
  const config = JSON.parse(await readFile(filename, 'utf8'));
  if (config.format !== 'kuvi-postgres-backup-config' || config.version !== 1 ||
      !/^[A-F0-9]{40}$/.test(config.recipient || '') ||
      !['envFile', 'pgDump', 'pgRestore', 'gpgHome', 'outputDir'].every(k =>
        typeof config[k] === 'string' && path.isAbsolute(config[k]))) fail('INVALID_CONFIG');
  config.outputDir = await privateDirectory(config.outputDir);
  config.gpgHome = await privateDirectory(config.gpgHome);
  config.maxArchiveBytes ??= 2 * 1024 ** 3;
  config.timeoutMs ??= 45 * 60 * 1000;
  if (!Number.isSafeInteger(config.maxArchiveBytes) || config.maxArchiveBytes < 1024 ||
      config.maxArchiveBytes > 20 * 1024 ** 3 || !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 1000 || config.timeoutMs > 2 * 3600 * 1000) fail('INVALID_LIMITS');
  const envStat = await lstat(config.envFile);
  if (!envStat.isFile() || envStat.isSymbolicLink() || (envStat.mode & 0o077) !== 0) fail('PRIVATE_ENV_REQUIRED');
  const secrets = dotenv.parse(await readFile(config.envFile));
  config.databaseUrl = secrets.DATABASE_URL;
  config.pgEnv = postgresEnvironment(config.databaseUrl);
  if(config.requiredBackupRole &&
      (config.requiredBackupRole!==names.backup || config.pgEnv.PGUSER!==names.backup)) fail('BACKUP_ROLE_REQUIRED');
  return config;
}
function launch(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  child.stderr.resume(); // Never leak SQL rows, connection URLs or stderr to logs.
  const done = new Promise((resolve, reject) => {
    child.once('error', () => reject(new BackupError('TOOL_START_FAILED')));
    child.once('close', code => code === 0 ? resolve() : reject(new BackupError(
      command.endsWith('pg_dump') ? 'PG_DUMP_FAILED' : command.endsWith('pg_restore') ? 'PG_RESTORE_FAILED' : 'GPG_FAILED')));
  });
  done.catch(() => {});
  return { child, done };
}
async function capture(command, args, env) {
  const {child, done} = launch(command, args, {env});
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    let text = '';
    for await (const bytes of child.stdout) {
      text += bytes.toString('utf8');
      if (text.length > 64 * 1024) { child.kill(); fail('TOOL_OUTPUT_LIMIT'); }
    }
    await done;
    return text;
  } finally { clearTimeout(timer); }
}
export async function fileDigest(filename) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(filename)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}
async function atomicJson(filename, value) {
  const part = `${filename}.${randomUUID()}.part`;
  const file = await open(part, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(part, filename);
}
async function syncDirectory(directory) {
  const fd = await open(directory, 'r');
  try { await fd.sync(); } finally { await fd.close(); }
}
async function databaseInfo(config) {
  const db = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 8000,
    application_name: 'kuvi-backup-preflight', options: '-c default_transaction_read_only=on -c statement_timeout=10000' });
  try {
    await db.connect();
    const {rows:[row]} = await db.query(`SELECT current_setting('server_version_num')::int AS version,
        pg_database_size(current_database())::text AS bytes`);
    return {major: Math.floor(row.version / 10000), bytes: Number(row.bytes)};
  } finally { await db.end(); }
}
export async function runBackup(config) {
  const database = await databaseInfo(config);
  const major = database.major;
  const disk = await statfs(config.outputDir);
  if (disk.bavail * disk.bsize < 1024 ** 3 + database.bytes * 2) fail('LOW_DISK_SPACE');
  const version = await capture(config.pgDump, ['--version']);
  if (!new RegExp(`PostgreSQL\\) ${major}\\.`).test(version)) fail('PG_CLIENT_VERSION_MISMATCH');
  const gpgArgs = ['--no-options', '--homedir', config.gpgHome, '--batch', '--no-tty'];
  const secrets = await capture('gpg', [...gpgArgs, '--with-colons', '--list-secret-keys']);
  if (/^sec:/m.test(secrets)) fail('PRIVATE_KEY_PRESENT_ON_BACKUP_HOST');
  const keys = await capture('gpg', [...gpgArgs, '--with-colons', '--fingerprint', '--list-keys', config.recipient]);
  if (!keys.split('\n').some(line => line.startsWith('fpr:') && line.split(':')[9] === config.recipient)) fail('RECIPIENT_NOT_FOUND');
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const filename = `kuvi-db-${stamp}-${randomUUID().slice(0,8)}.dump.gpg`;
  const target = path.join(config.outputDir, filename), part = `${target}.part`;
  const fd = await open(part, 'wx', 0o600);
  const dump = launch(config.pgDump, ['--no-password', '--format=custom', '--compress=6',
    '--no-owner', '--no-acl', '--lock-wait-timeout=10s'], {env: config.pgEnv});
  dump.child.stdin.end();
  const gpg = launch('gpg', [...gpgArgs, '--trust-model', 'always', '--cipher-algo', 'AES256',
    '--compress-algo', 'none', '--recipient', config.recipient, '--encrypt']);
  let bytes = 0; const hash = createHash('sha256');
  const limiter = new Transform({ transform(chunk, _, callback) {
    bytes += chunk.length;
    if (bytes > config.maxArchiveBytes) return callback(new BackupError('ARCHIVE_SIZE_LIMIT'));
    hash.update(chunk); callback(null, chunk);
  }});
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.timeoutMs);
  let published = false;
  try {
    await Promise.all([
      pipeline(dump.child.stdout, gpg.child.stdin, {signal: abort.signal}),
      pipeline(gpg.child.stdout, limiter, createWriteStream(part, {fd: fd.fd, autoClose: false}), {signal: abort.signal}),
      dump.done, gpg.done,
    ]);
    if (bytes < 1) fail('EMPTY_ARCHIVE');
    await fd.sync();
    await rename(part, target);
    const sourceIdentity = createHash('sha256').update(JSON.stringify([
      config.pgEnv.PGHOST, config.pgEnv.PGPORT, config.pgEnv.PGDATABASE,
    ])).digest('hex');
    const manifest = validateManifest({format: 'kuvi-postgres-backup', version: 1,
      filename, createdAt: new Date().toISOString(), sha256: hash.digest('hex'), bytes,
      databaseMajor: major, sourceIdentity});
    await atomicJson(`${target}.json`, manifest);
    await syncDirectory(config.outputDir);
    published = true;
    return manifest;
  } finally {
    clearTimeout(timer); abort.abort();
    dump.child.kill(); gpg.child.kill();
    await Promise.allSettled([dump.done, gpg.done]);
    let closeError;
    try { await fd.close(); }
    catch (error) { if (error.code !== 'EBADF') closeError = error; }
    // A stream destroyed by an error may have closed its supplied descriptor.
    // Cleanup must still run instead of stopping at a second close (EBADF).
    if (!published) {
      await unlink(part).catch(() => {});
      await unlink(target).catch(() => {});
      await unlink(`${target}.json`).catch(() => {});
    }
    if (closeError) fail('ARCHIVE_CLOSE_FAILED');
  }
}
export async function readManifest(config, filename) {
  if (!backupName.test(filename)) fail('INVALID_BACKUP_NAME');
  const file = path.join(config.outputDir, filename);
  for (const target of [file, `${file}.json`]) {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_BACKUP_FILE');
  }
  const manifest = validateManifest(JSON.parse(await readFile(`${file}.json`, 'utf8')));
  if (manifest.filename !== filename) fail('INVALID_MANIFEST');
  const actual = await fileDigest(file);
  if (actual.sha256 !== manifest.sha256 || actual.bytes !== manifest.bytes) fail('ARCHIVE_CHECKSUM_MISMATCH');
  return manifest;
}
export async function listBackups(config) {
  const names = (await readdir(config.outputDir)).filter(name => backupName.test(name)).sort().reverse();
  const manifests = [];
  for (const name of names) {
    try { manifests.push(await readManifest(config, name)); }
    catch { fail('INVALID_ARCHIVE_IN_INVENTORY'); }
  }
  return manifests;
}
export async function acknowledge(config, filename, expectedHash) {
  if (!hashPattern.test(expectedHash)) fail('INVALID_ACKNOWLEDGEMENT');
  const manifest = await readManifest(config, filename);
  if (manifest.sha256 !== expectedHash) fail('INVALID_ACKNOWLEDGEMENT');
  await atomicJson(path.join(config.outputDir, `${filename}.receipt.json`),
    {format: 'kuvi-backup-copy-receipt', version: 1, sha256: expectedHash, receivedAt: new Date().toISOString()});
  await syncDirectory(config.outputDir);
}

export async function pruneBackups(config, now = new Date()) {
  const backups = await listBackups(config);
  const candidates = backups.slice(7).filter(backup =>
      now.getTime() - Date.parse(backup.createdAt) > 14 * 24 * 3600 * 1000);
  let removed = 0;
  for (const backup of candidates) {
    const target = path.join(config.outputDir, backup.filename);
    const receiptFile = `${target}.receipt.json`;
    const stat = await lstat(receiptFile).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) continue;
    let receipt;
    try { receipt = JSON.parse(await readFile(receiptFile, 'utf8')); } catch { continue; }
    if (receipt.format !== 'kuvi-backup-copy-receipt' || receipt.version !== 1 ||
        receipt.sha256 !== backup.sha256 || !Number.isFinite(Date.parse(receipt.receivedAt))) continue;
    // listBackups already verified each complete archive; foreign files and
    // unacknowledged snapshots never participate in retention.
    await unlink(target);
    await unlink(`${target}.json`);
    await unlink(receiptFile);
    removed++;
  }
  await syncDirectory(config.outputDir);
  return removed;
}

export async function verifyRestore(config, filename, expectedHash) {
  if (!/^restore-check-[a-f0-9-]{36}\.dump$/.test(filename) ||
      !hashPattern.test(expectedHash || '')) fail('INVALID_RESTORE_CHECK');
  if(!config.restoreEnvFile || config.restoreOwner!==names.restoreOwner) fail('RESTORE_PROFILE_REQUIRED');
  const restoreUrl=await privateDatabaseUrl(config.restoreEnvFile);
  const restoreConnection=new URL(restoreUrl);
  const login=decodeURIComponent(restoreConnection.username);
  if(login!==names.restore || decodeURIComponent(restoreConnection.pathname.slice(1))!=='postgres') fail('RESTORE_ROLE_REQUIRED');
  const root = await privateDirectory(path.join(path.dirname(config.gpgHome), 'restore-check'));
  const archive = path.join(root, filename);
  const stat = await lstat(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('PRIVATE_RESTORE_FILE_REQUIRED');
  const actual = await fileDigest(archive);
  if (actual.sha256 !== expectedHash) {
    await unlink(archive);
    fail('RESTORE_CHECKSUM_MISMATCH');
  }
  const source = config.pgEnv.PGDATABASE;
  const target = `kuvi_restore_check_${randomUUID().replaceAll('-', '')}`;
  const role = names.restoreOwner;
  if (source === target || !/^kuvi_restore_check_[a-f0-9]{32}$/.test(target)) fail('UNSAFE_RESTORE_TARGET');
  const admin = new Client({ connectionString: restoreUrl, connectionTimeoutMillis: 8000 });
  let databaseCreated = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${target}" OWNER "${role}"`);
    databaseCreated = true;
    await admin.query(`SET ROLE ${identifier(role)}`);
    await admin.query(`REVOKE CONNECT ON DATABASE "${target}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${target}" TO ${identifier(login)}`);
    await admin.query('RESET ROLE');
    const env = {...postgresEnvironment(restoreUrl), PGDATABASE: target, PGAPPNAME: 'kuvi-isolated-restore-check',
      PGOPTIONS: '-c statement_timeout=1800000'};
    const restore = launch(config.pgRestore, ['--no-password','--no-owner','--no-acl',
      '--exit-on-error','--single-transaction','--role',role,'--dbname',target,archive], {env});
    restore.child.stdin.end(); restore.child.stdout.resume();
    const timer = setTimeout(() => restore.child.kill(), config.timeoutMs);
    try { await restore.done; } finally { clearTimeout(timer); }
    const url = new URL(restoreUrl); url.pathname = `/${target}`; url.searchParams.delete('schema');
    const db = new Client({connectionString: url.toString(), connectionTimeoutMillis: 8000});
    try {
      await db.connect();
      await db.query(`SET ROLE ${identifier(role)}`);
      const {rows:[schema]} = await db.query(`SELECT
        (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS tables,
        (SELECT count(*)::int FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migrations`);
      if (schema.tables < 1 || schema.migrations < 1) fail('RESTORE_SCHEMA_INCOMPLETE');
      let cursor = null;
      while (true) {
        const {rows} = await db.query(`SELECT "userId","documentId",content,sha256,"sizeBytes"
            FROM "DocumentBackup" ${cursor ? 'WHERE ("userId","documentId") > ($1,$2)' : ''}
            ORDER BY "userId","documentId" LIMIT 1`, cursor || []);
        if (!rows.length) break;
        const row = rows[0];
        if (row.content.length !== row.sizeBytes ||
            createHash('sha256').update(row.content).digest('hex') !== row.sha256) fail('RESTORED_DOCUMENT_INTEGRITY_FAILED');
        cursor = [row.userId,row.documentId];
      }
      return {isolatedRestoreVerified: true, encryptedDocumentIntegrity: true,
        tables: schema.tables, migrations: schema.migrations};
    } finally { await db.end(); }
  } finally {
    try {
      if (databaseCreated) {
        await admin.query(`SET ROLE ${identifier(role)}`);
        await admin.query(`DROP DATABASE "${target}"`);
      }
    } finally {
      await admin.end();
      await unlink(archive).catch(() => {});
    }
  }
}
