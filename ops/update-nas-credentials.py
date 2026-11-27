#!/usr/bin/env python3
"""Prompt locally for a NAS password, replace the private credential and verify a fresh mount."""
import datetime
import fcntl
import getpass
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys
import uuid

PRIVATE = Path('/etc/kuvi-nas')
CREDENTIAL = PRIVATE / 'credentials'
STATE = Path('/home/miguel/.config/kuvi-backup/last-nas-push.json')
MOUNT = 'mnt-kuvi\\x2dnas.mount'
AUTOMOUNT = 'mnt-kuvi\\x2dnas.automount'


class RotationError(Exception):
    pass


def credentials_with_password(original, password):
    fields = {}
    for line in original.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        key = key.strip()
        if not separator or key not in ('username', 'password', 'domain') or key in fields:
            raise RotationError('EXISTING_CREDENTIAL_FORMAT_REQUIRES_REVIEW')
        fields[key] = value
    if fields.get('username') != 'kuvi_backup' or 'password' not in fields:
        raise RotationError('EXPECTED_NAS_ACCOUNT_REQUIRED')
    if not password or any(c in password for c in '\r\n\0'):
        raise RotationError('INVALID_NEW_PASSWORD')
    fields['password'] = password
    return ''.join(key + '=' + value + '\n' for key, value in fields.items())


def private_path(path, directory=False, owner=0):
    info = path.lstat()
    if (not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or info.st_uid != owner or info.st_mode & 0o077):
        raise RotationError('PRIVATE_PATH_REQUIRED')


def atomic_write(path, data, owner=None):
    if path.is_symlink():
        raise RotationError('SYMLINK_REJECTED')
    temporary = path.parent / ('.credential-update-' + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            if owner is not None:
                os.fchown(stream.fileno(), *owner)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def command(arguments, code, timeout=45):
    try:
        return subprocess.run(arguments, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        raise RotationError(code) from None


def mark_reconnect_failure():
    operator = pwd.getpwnam('miguel')
    previous = {}
    if STATE.exists():
        private_path(STATE, owner=operator.pw_uid)
        previous = json.loads(STATE.read_text())
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    value = {'format': 'kuvi-nas-push-status', 'version': 1, 'state': 'failed',
             'startedAt': now, 'finishedAt': now, 'code': 'NAS_RECONNECT_FAILED',
             'lastSuccessAt': previous.get('finishedAt') if previous.get('state') == 'succeeded' else previous.get('lastSuccessAt'),
             'lastSuccessLatest': previous.get('latest') if previous.get('state') == 'succeeded' else previous.get('lastSuccessLatest')}
    atomic_write(STATE, (json.dumps(value) + '\n').encode(), (operator.pw_uid, operator.pw_gid))


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1 or not sys.stdin.isatty():
        raise RotationError('RUN_WITH_SUDO_IN_AN_INTERACTIVE_TERMINAL')
    os.umask(0o077)
    private_path(PRIVATE, directory=True)
    private_path(CREDENTIAL)
    original = CREDENTIAL.read_text()
    credentials_with_password(original, 'format-validation-only')
    with open('/home/miguel/kuvi-postgres-backups/.backup.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RotationError('BACKUP_OR_NAS_TRANSFER_RUNNING_RETRY_LATER') from None
        password = getpass.getpass('Nueva contraseña de kuvi_backup en el NAS: ')
        confirmation = getpass.getpass('Repite la nueva contraseña del NAS: ')
        if password != confirmation:
            raise RotationError('PASSWORDS_DID_NOT_MATCH_NO_CHANGE')
        updated = credentials_with_password(original, password)
        del password, confirmation
        saved = False
        authenticated = False
        try:
            command(['systemctl', 'stop', MOUNT, AUTOMOUNT], 'NAS_BUSY_CREDENTIAL_NOT_CHANGED')
            for unit in (MOUNT, AUTOMOUNT):
                active = command(['systemctl', 'show', unit, '-p', 'ActiveState', '--value'], 'MOUNT_STATE_CHECK_FAILED')
                if active not in ('inactive', 'failed'):
                    raise RotationError('NAS_BUSY_CREDENTIAL_NOT_CHANGED')
            atomic_write(CREDENTIAL, updated.encode())
            saved = True
            del updated, original
            private_path(CREDENTIAL)
            command(['systemctl', 'reset-failed', MOUNT, AUTOMOUNT], 'NAS_UNIT_RESET_FAILED')
            command(['systemctl', 'start', AUTOMOUNT], 'NAS_AUTOMOUNT_START_FAILED')
            command(['systemctl', 'start', MOUNT], 'NAS_RECONNECT_FAILED')
            authenticated = True
            # The parent holds the same lock; invoke its protected inner worker.
            result = command(['runuser', '-u', 'miguel', '--', '/usr/bin/node',
                              '/home/miguel/kuvi-api/ops/nas-push.mjs',
                              '/home/miguel/.config/kuvi-backup/config.json',
                              '/home/miguel/.config/kuvi-backup/nas-direct.json', '--locked'],
                             'NAS_BACKUP_VERIFICATION_FAILED', timeout=1200)
            value = json.loads(result)
            if value.get('ok') is not True or value.get('verified', 0) < 1:
                raise RotationError('NAS_BACKUP_VERIFICATION_FAILED')
            print(json.dumps({'ok': True, 'credentialsUpdated': True, 'freshMountVerified': True,
                              'verified': value['verified'], 'copied': value['copied']}))
        except (Exception, KeyboardInterrupt) as error:
            if saved and not authenticated:
                mark_reconnect_failure()
            # Preserve the new credential for correction if authentication failed;
            # restoring the obsolete password would not repair a changed NAS account.
            subprocess.run(['systemctl', 'start', AUTOMOUNT], capture_output=True, timeout=45)
            code = str(error) if isinstance(error, RotationError) else 'NAS_CREDENTIAL_UPDATE_NEEDS_REVIEW'
            print(json.dumps({'ok': False, 'code': code, 'credentialsUpdated': saved,
                              'freshMountVerified': authenticated}), file=sys.stderr)
            return 1
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({'ok': False, 'code': str(error) if isinstance(error, RotationError) else 'NAS_CREDENTIAL_UPDATE_FAILED'}), file=sys.stderr)
        sys.exit(1)
