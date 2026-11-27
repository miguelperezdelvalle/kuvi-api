#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupError, loadConfig, runBackup, listBackups, acknowledge, pruneBackups, verifyRestore } from './backup-core.mjs';

async function main() {
  const [action, configFile, filename, hash] = process.argv.slice(2);
  if (!['run', 'run-locked', 'prune', 'prune-locked', 'list', 'ack', 'verify-restore'].includes(action) || !configFile) throw new BackupError('INVALID_ARGUMENTS');
  const config = await loadConfig(configFile);
  if (action === 'run' || action === 'prune') {
    const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75',
      path.join(config.outputDir, '.backup.lock'), process.execPath,
      fileURLToPath(import.meta.url), `${action}-locked`, path.resolve(configFile)], {stdio: 'inherit'});
    const code = await new Promise(resolve => { child.on('error', () => resolve(1)); child.on('close', resolve); });
    process.exitCode = code ?? 1;
    return;
  }
  if (action === 'run-locked') {
    console.log(JSON.stringify({ok: true, backup: await runBackup(config)}));
  } else if (action === 'verify-restore') {
    console.log(JSON.stringify({ok: true, ...await verifyRestore(config, filename, hash)}));
  } else if (action === 'prune-locked') {
    console.log(JSON.stringify({ok: true, removed: await pruneBackups(config)}));
  } else if (action === 'list') {
    console.log(JSON.stringify({ok: true, backups: await listBackups(config)}));
  } else {
    await acknowledge(config, filename, hash);
    console.log(JSON.stringify({ok: true, acknowledged: filename}));
  }
}
main().catch(error => {
  console.error(JSON.stringify({ok: false, code: error instanceof BackupError ? error.code : 'BACKUP_OPERATION_FAILED'}));
  process.exitCode = 1;
});
