#!/usr/bin/env python3
"""Deploy prepared Kuvi runtime artifacts; never run npm or migrations as root."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

REPO = Path('/home/miguel/kuvi-api')
RELEASES = Path('/opt/kuvi-api/releases')
CURRENT = Path('/opt/kuvi-api/current')
STATE = Path('/var/lib/kuvi-deployments')
UNIT = 'kuvi-backend.service'
CANDIDATE = 'kuvi-backend-deploy-candidate.service'
IDENTIFIER = re.compile(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}')


class DeploymentError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise DeploymentError(code)


def fingerprint(root, sealed=False):
    root = Path(root)
    require(not root.is_symlink() and root.is_dir(), 'RUNTIME_DIRECTORY_REQUIRED')
    root = root.resolve()
    require(set(p.name for p in root.iterdir()) == {'dist', 'node_modules', 'package.json'}, 'UNEXPECTED_RUNTIME_CONTENTS')
    require((root / 'dist/app/server.js').is_file(), 'COMPILED_SERVER_REQUIRED')
    entries = []
    paths = [root]
    for base, dirs, files in os.walk(root, followlinks=False):
        paths.extend(Path(base) / name for name in dirs + files)
    for path in sorted(paths, key=lambda p: str(p.relative_to(root)).encode('utf-8')):
        info = path.lstat()
        relative = path.relative_to(root).as_posix()
        require(path.name != '.env' and not path.name.startswith('.env.'), 'ENVIRONMENT_IN_RUNTIME')
        if sealed:
            require(info.st_uid == 0 and info.st_gid == 0, 'RUNTIME_NOT_ROOT_OWNED')
            if not stat.S_ISLNK(info.st_mode):
                require(not info.st_mode & (0o022 | stat.S_ISUID | stat.S_ISGID), 'WRITABLE_RUNTIME')
        if stat.S_ISLNK(info.st_mode):
            resolved = path.resolve(strict=True)
            require(resolved.is_relative_to(root), 'EXTERNAL_RUNTIME_SYMLINK')
            entries.append([relative, 'link', os.readlink(path)])
        elif stat.S_ISDIR(info.st_mode):
            entries.append([relative, 'directory'])
        elif stat.S_ISREG(info.st_mode):
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            entries.append([relative, 'file', digest.hexdigest()])
        else:
            raise DeploymentError('SPECIAL_FILE_IN_RUNTIME')
    digest = hashlib.sha256(json.dumps(entries, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    return {'sha256': digest, 'entries': len(entries)}


def command(args, timeout=30):
    try:
        return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except (subprocess.SubprocessError, OSError):
        raise DeploymentError('OPERATION_FAILED_' + Path(args[0]).name.upper()) from None


def property_value(name):
    return command(['systemctl', 'show', UNIT, '-p', name, '--value'])


def health(port=3000):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(30):
        try:
            with opener.open(f'http://127.0.0.1:{port}/db-health', timeout=2) as response:
                require(response.status == 200 and json.load(response).get('database') == 'connected', 'BAD_DB_HEALTH')
            try:
                opener.open(f'http://127.0.0.1:{port}/users/me', timeout=2).close()
                return False
            except urllib.error.HTTPError as error:
                if error.code == 401:
                    return True
        except (OSError, ValueError, DeploymentError):
            pass
        time.sleep(0.5)
    return False


def atomic_link(target):
    temp = CURRENT.parent / ('.current-' + uuid.uuid4().hex)
    try:
        temp.symlink_to(target)
        os.replace(temp, CURRENT)
        descriptor = os.open(CURRENT.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temp.is_symlink():
            temp.unlink()


def transition(target, previous, switch, restart, probe):
    """If activation fails after the pointer changed, restore and verify the old release."""
    try:
        switch(target)
        restart()
        require(probe(), 'NEW_RELEASE_UNHEALTHY')
    except BaseException:
        try:
            switch(previous)
            restart()
            require(probe(), 'ROLLBACK_HEALTH_FAILED')
        except BaseException:
            raise DeploymentError('ROLLBACK_REQUIRES_ADMINISTRATOR') from None
        raise DeploymentError('ACTIVATION_FAILED_PREVIOUS_RELEASE_RESTORED') from None


def validate_service():
    require(property_value('User') == 'kuvi-api' and property_value('Group') == 'kuvi-api', 'ISOLATED_RUNTIME_REQUIRED')
    require(property_value('WorkingDirectory') == str(CURRENT), 'UNEXPECTED_WORKING_DIRECTORY')
    require(not property_value('DropInPaths'), 'SERVICE_OVERRIDES_REQUIRE_REVIEW')
    require(property_value('ProtectSystem') == 'strict' and property_value('ProtectHome') == 'yes' and property_value('NoNewPrivileges') == 'yes', 'SANDBOX_REQUIRED')
    installed = Path('/etc/systemd/system') / UNIT
    require(installed.read_bytes() == (REPO / 'ops/kuvi-backend.service').read_bytes(), 'UNIT_CHANGES_REQUIRE_SEPARATE_REVIEW')
    require(CURRENT.is_symlink(), 'CURRENT_SYMLINK_REQUIRED')
    previous = CURRENT.resolve(strict=True)
    require(previous.parent == RELEASES and not (RELEASES / previous.name).is_symlink(), 'CURRENT_RELEASE_OUTSIDE_MANAGED_DIRECTORY')
    require(health(), 'EXISTING_RELEASE_UNHEALTHY')
    return previous


def schema_check(signature):
    require(re.fullmatch(r'[a-f0-9]{64}', signature or ''), 'INVALID_SCHEMA_SIGNATURE')
    args = ['/usr/bin/node', str(REPO / 'ops/release-schema.mjs'), signature]
    if os.geteuid() == 0:
        args = ['runuser', '-u', 'miguel', '--'] + args
    command(args, timeout=25)


def bundle_info(identifier):
    require(IDENTIFIER.fullmatch(identifier or ''), 'INVALID_RELEASE_IDENTIFIER')
    bundle = Path('/home/miguel/.local/share/kuvi-deploy') / identifier
    require(not bundle.is_symlink(), 'BUNDLE_SYMLINK_REJECTED')
    meta = bundle / 'release.json'
    require(meta.is_file() and not meta.is_symlink(), 'RELEASE_MANIFEST_REQUIRED')
    manifest = json.loads(meta.read_text())
    require(manifest.get('format') == 'kuvi-runtime-release' and manifest.get('version') == 1 and manifest.get('id') == identifier, 'INVALID_RELEASE_MANIFEST')
    require(re.fullmatch(r'[a-f0-9]{40}', manifest.get('commit', '')), 'INVALID_COMMIT')
    require(identifier.endswith('-' + manifest['commit'][:12]), 'COMMIT_IDENTIFIER_MISMATCH')
    require(manifest.get('node') == command(['/usr/bin/node', '--version']), 'NODE_VERSION_CHANGED')
    require(manifest.get('checks') == ['npm-ci-locked', 'prisma-generate', 'general-tests', 'backup-tests', 'migration-checksums'], 'RELEASE_CHECKS_REQUIRED')
    require(fingerprint(bundle / 'runtime') == manifest.get('tree'), 'PREPARED_RUNTIME_CHANGED')
    schema_check(manifest.get('schemaSignature'))
    return bundle, manifest


def protected_path(path, directory=False):
    info = path.lstat()
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and info.st_uid == 0 and info.st_gid == 0 and not info.st_mode & 0o077, 'PRIVATE_ROOT_PATH_REQUIRED')


def record(value):
    require(not STATE.is_symlink(), 'STATE_SYMLINK_REJECTED')
    STATE.mkdir(mode=0o700, exist_ok=True)
    protected_path(STATE, directory=True)
    value = {**value, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    target = STATE / ('event-' + uuid.uuid4().hex + '.json')
    with target.open('x') as stream:
        os.chmod(target, 0o600)
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    if value.get('status') == 'active':
        temp = STATE / ('.last-' + uuid.uuid4().hex)
        with temp.open('x') as stream:
            os.chmod(temp, 0o600)
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, STATE / 'last-success.json')


def candidate(target):
    candidate_unit = Path('/run/systemd/system') / CANDIDATE
    require(not candidate_unit.exists() and not candidate_unit.is_symlink(), 'CANDIDATE_UNIT_ALREADY_EXISTS')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    template = (Path('/etc/systemd/system') / UNIT).read_text()
    template = re.sub(r'^WorkingDirectory=.*$', 'WorkingDirectory=' + str(target), template, flags=re.M)
    template = re.sub(r'^ExecStart=.*$', f'ExecStart=/usr/bin/env PORT={port} HOST=127.0.0.1 /usr/bin/node {target}/dist/app/server.js', template, flags=re.M)
    try:
        with candidate_unit.open('x') as stream:
            os.chmod(candidate_unit, 0o644)
            stream.write(template)
        command(['systemd-analyze', 'verify', str(candidate_unit)])
        command(['systemctl', 'daemon-reload'])
        command(['systemctl', 'start', CANDIDATE])
        require(health(port), 'CANDIDATE_UNHEALTHY_PRODUCTION_UNCHANGED')
    finally:
        # Leave production running; only the uniquely named temporary unit is removed.
        subprocess.run(['systemctl', 'stop', CANDIDATE], capture_output=True, timeout=30)
        if candidate_unit.is_file():
            candidate_unit.unlink()
        command(['systemctl', 'daemon-reload'])
        subprocess.run(['systemctl', 'reset-failed', CANDIDATE], capture_output=True, timeout=30)


def deploy(identifier=None, rollback=False, check=False):
    require(check or os.geteuid() == 0, 'SUDO_REQUIRED_FOR_ACTIVATION')
    previous = validate_service()
    previous_tree = fingerprint(previous, sealed=True)
    if rollback:
        protected_path(STATE, directory=True)
        protected_path(STATE / 'last-success.json')
        saved = json.loads((STATE / 'last-success.json').read_text())
        require(saved['target'] == str(previous), 'ACTIVE_RELEASE_CHANGED_SINCE_LAST_DEPLOYMENT')
        target = Path(saved['previous'])
        require(target.parent == RELEASES and target.resolve(strict=True) == target, 'INVALID_ROLLBACK_TARGET')
        require(fingerprint(target, sealed=True) == saved['previousTree'], 'ROLLBACK_RUNTIME_CHANGED')
        signature = saved['schemaSignature']
        schema_check(signature)
        commit = None
    else:
        bundle, manifest = bundle_info(identifier)
        signature, commit = manifest['schemaSignature'], manifest['commit']
        target = RELEASES / identifier
        require(not target.exists() and not target.is_symlink(), 'RELEASE_ALREADY_EXISTS')
    if check:
        print(json.dumps({'ok': True, 'preflight': True, 'productionChanged': False, 'release': identifier}))
        return
    protected_path(Path('/etc/kuvi'), directory=True)
    protected_path(Path('/etc/kuvi/backend.env'))
    with open('/run/lock/kuvi-service-isolation.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeploymentError('ANOTHER_DEPLOYMENT_IS_RUNNING') from None
        require(CURRENT.resolve(strict=True) == previous, 'ACTIVE_RELEASE_CHANGED')
        if not rollback:
            require(shutil.disk_usage(RELEASES).free > 1024**3, 'INSUFFICIENT_DISK_SPACE')
            shutil.copytree(bundle / 'runtime', target, symlinks=True)
            for base, dirs, files in os.walk(target, followlinks=False):
                os.chmod(base, 0o755)
                os.chown(base, 0, 0)
                for name in dirs + files:
                    item = Path(base) / name
                    os.chown(item, 0, 0, follow_symlinks=False)
                    if item.is_file() and not item.is_symlink():
                        os.chmod(item, 0o755 if item.stat().st_mode & 0o111 else 0o644)
            require(fingerprint(target, sealed=True) == manifest['tree'], 'COPIED_RUNTIME_CHANGED')
        require(not STATE.is_symlink(), 'STATE_SYMLINK_REJECTED')
        STATE.mkdir(mode=0o700, exist_ok=True)
        protected_path(STATE, directory=True)
        event = {'action': 'rollback' if rollback else 'deploy', 'target': str(target), 'previous': str(previous), 'previousTree': previous_tree, 'schemaSignature': signature, 'commit': commit}
        record({**event, 'status': 'prepared'})
        try:
            candidate(target)
            schema_check(signature)
            transition(target, previous, atomic_link, lambda: command(['systemctl', 'restart', UNIT]), health)
        except BaseException:
            record({**event, 'status': 'failed', 'current': str(CURRENT.resolve())})
            raise
        record({**event, 'status': 'active'})
        print(json.dumps({'ok': True, 'action': event['action'], 'release': target.name, 'dbHealth': True, 'runtimeUser': 'kuvi-api', 'previousRelease': previous.name}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--fingerprint', metavar='RUNTIME')
    group.add_argument('--check', metavar='RELEASE_ID')
    group.add_argument('--apply', metavar='RELEASE_ID')
    group.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    if args.fingerprint:
        print(json.dumps(fingerprint(args.fingerprint)))
    else:
        for sig in [signal.SIGINT, signal.SIGTERM]:
            signal.signal(sig, lambda *_: (_ for _ in ()).throw(DeploymentError('INTERRUPTED')))
        deploy(args.check or args.apply, rollback=args.rollback, check=bool(args.check))


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        code = str(error) if isinstance(error, DeploymentError) else 'DEPLOYMENT_FAILED_REVIEW_PRIVATE_STATE'
        print(json.dumps({'ok': False, 'code': code}), file=sys.stderr)
        sys.exit(1)
