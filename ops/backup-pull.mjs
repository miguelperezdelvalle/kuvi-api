#!/usr/bin/env node
// Runs on the receiving computer. Transfers ciphertext only, never DB secrets.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const namePattern = /^kuvi-db-\d{8}T\d{6}Z-[a-f0-9]{8}\.dump\.gpg$/;
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
async function command(program, args) {
  const child = spawn(program, args, {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  child.stderr.resume();
  let text = '';
  child.stdout.on('data', bytes => {
    text += bytes.toString('utf8');
    if (text.length > 4 * 1024 * 1024) child.kill();
  });
  const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
  try {
    await new Promise((resolve, reject) => {
      child.on('error', () => reject(new Error('TRANSFER_TOOL_FAILED')));
      child.on('close', code => code === 0 ? resolve() : reject(new Error('TRANSFER_FAILED')));
    });
    return text;
  } finally { clearTimeout(timer); }
}
async function digest(file) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return {sha256: hash.digest('hex'), bytes};
}
async function main() {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (config.format !== 'kuvi-backup-pull-config' || config.version !== 1 ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(config.sshAlias || '') ||
      !['remoteScript','remoteConfig','remoteDirectory'].every(key => /^\/[A-Za-z0-9_./-]+$/.test(config[key] || '')) ||
      !path.isAbsolute(config.localDirectory || '')) throw new Error('INVALID_PULL_CONFIG');
  const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', config.sshAlias];
  const remote = action => ['node', config.remoteScript, action, config.remoteConfig].map(quote).join(' ');
  await mkdir(config.localDirectory, {recursive: true, mode: 0o700});
  const response = JSON.parse(await command('ssh', [...ssh, remote('list')]));
  if (response.ok !== true || !Array.isArray(response.backups) || response.backups.length > 5000) throw new Error('INVALID_REMOTE_INVENTORY');
  let copied = 0;
  for (const backup of response.backups) {
    if (!namePattern.test(backup.filename || '') || !/^[a-f0-9]{64}$/.test(backup.sha256 || '') ||
        !Number.isSafeInteger(backup.bytes) || backup.bytes < 1 || backup.bytes > 20 * 1024 ** 3) throw new Error('INVALID_REMOTE_MANIFEST');
    const target = path.join(config.localDirectory, backup.filename);
    const stat = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('INVALID_LOCAL_COPY');
    if (stat) {
      const existing = await digest(target);
      if (existing.sha256 !== backup.sha256 || existing.bytes !== backup.bytes) throw new Error('LOCAL_COPY_CONFLICT');
    } else {
      const part = `${target}.${randomUUID()}.part`;
      try {
        await command('scp', ['-o','BatchMode=yes','-o','ConnectTimeout=8',
          `${config.sshAlias}:${config.remoteDirectory}/${backup.filename}`, part]);
        const result = await digest(part);
        if (result.sha256 !== backup.sha256 || result.bytes !== backup.bytes) throw new Error('TRANSFER_CHECKSUM_MISMATCH');
        const fd = await open(part, 'r+');
        try { await fd.sync(); } finally { await fd.close(); }
        await rename(part, target);
        copied++;
      } finally { await unlink(part).catch(() => {}); }
    }
    const receipt = await open(`${target}.json`, 'w', 0o600);
    try { await receipt.writeFile(`${JSON.stringify(backup)}\n`); await receipt.sync(); }
    finally { await receipt.close(); }
    // A receipt is sent only after the off-host bytes have been verified and
    // fsynced. It allows later server retention; it does not delete anything.
    const ack = `${remote('ack')} ${quote(backup.filename)} ${quote(backup.sha256)}`;
    const result = JSON.parse(await command('ssh', [...ssh, ack]));
    if (result.ok !== true || result.acknowledged !== backup.filename) throw new Error('ACKNOWLEDGEMENT_FAILED');
  }
  console.log(JSON.stringify({ok: true, verified: response.backups.length, copied}));
}
main().catch(error => {
  const allowed = /^[A-Z_]+$/.test(error.message || '') ? error.message : 'BACKUP_PULL_FAILED';
  console.error(JSON.stringify({ok: false, code: allowed})); process.exitCode = 1;
});
