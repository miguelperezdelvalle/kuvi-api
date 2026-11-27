#!/usr/bin/env bash
# Never prints credentials. Run --check as miguel; --apply requires sudo.
set -Eeuo pipefail
umask 077
source_dir=/home/miguel/kuvi-api
unit=kuvi-backend.service
candidate=kuvi-backend-candidate.service
template="$source_dir/ops/kuvi-backend.service"
fail() { printf '%s\n' "$1" >&2; exit 1; }
mode=${1:---check}
[[ $# -le 1 && ( $mode == --check || $mode == --apply || $mode == --resume ) ]] || fail 'Use --check, --apply or --resume.'
for cmd in node python3 rsync systemctl systemd-analyze runuser flock install; do
  command -v "$cmd" >/dev/null || fail "Missing command: $cmd"
done
[[ -f "$template" && ! -L "$template" ]] || fail 'Unit template missing or symlinked.'
[[ -f "$source_dir/dist/app/server.js" && -d "$source_dir/node_modules" ]] || fail 'Build the application as miguel first.'
[[ -f "$source_dir/.env" && ! -L "$source_dir/.env" ]] || fail 'Runtime environment missing or symlinked.'
grep -Eq "^DATABASE_URL=['\"]?postgres(ql)?://kuvi_app:" "$source_dir/.env" || fail 'Runtime DATABASE_URL must use kuvi_app.'
[[ $(systemctl show "$unit" -p FragmentPath --value) == /etc/systemd/system/kuvi-backend.service ]] || fail 'Unexpected service unit path.'
[[ -z $(systemctl show "$unit" -p DropInPaths --value) ]] || fail 'Review existing service overrides before installation.'
systemd-analyze verify "$template" >/dev/null 2>&1 || fail 'Unit validation failed.'
/usr/bin/node --input-type=module -e 'const r=await fetch("http://127.0.0.1:3000/db-health",{signal:AbortSignal.timeout(5000)});if(r.status!==200)process.exit(1)' >/dev/null 2>&1 || fail 'Current database health check failed.'
[[ $(df -Pk /opt | awk 'NR==2 {print $4}') -gt 1048576 ]] || fail 'At least 1 GiB free space required in /opt.'
if [[ $mode == --check ]]; then
  printf '%s\n' 'Preflight OK. No service, account or credentials changed. Apply requires sudo.'
  exit 0
fi
[[ $EUID == 0 ]] || fail 'Run --apply or --resume using sudo in your terminal; do not share the password.'
exec 9>/run/lock/kuvi-service-isolation.lock
flock -n 9 || fail 'Another installation is running.'
if [[ $mode == --apply ]]; then
  [[ ! -e /opt/kuvi-api && ! -L /opt/kuvi-api && ! -e /etc/kuvi && ! -L /etc/kuvi ]] || fail 'Existing installation found; review it before replacing anything.'
  ! getent passwd kuvi-api >/dev/null || fail 'Account kuvi-api already exists; review it first.'
  ! getent group kuvi-api >/dev/null || fail 'Group kuvi-api already exists; review it first.'
else
  # Resume only the reviewed preparation. Never remove accounts or prior releases.
  /usr/bin/python3 - <<'PY'
import os,pwd,grp,stat,re
u=pwd.getpwnam('kuvi-api');g=grp.getgrnam('kuvi-api')
assert 0<u.pw_uid<1000 and u.pw_gid==g.gr_gid and u.pw_dir=='/nonexistent' and u.pw_shell=='/usr/sbin/nologin', 'Unexpected service account'
assert not g.gr_mem and not any(u.pw_name in x.gr_mem for x in grp.getgrall()), 'Unexpected group membership'
for p,mode in [('/opt/kuvi-api',0o755),('/opt/kuvi-api/releases',0o755),('/etc/kuvi',0o700)]:
 s=os.lstat(p);assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and s.st_gid==0 and stat.S_IMODE(s.st_mode)==mode, 'Unexpected installation directory'
s=os.lstat('/etc/kuvi/backend.env');assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600, 'Unexpected protected environment'
assert os.path.islink('/opt/kuvi-api/current'), 'Runtime link missing'
release=os.path.realpath('/opt/kuvi-api/current')
assert re.fullmatch(r'/opt/kuvi-api/releases/[0-9]{8}T[0-9]{6}Z',release), 'Unexpected release path'
for base,dirs,files in os.walk(release):
 for name in ['.']+dirs+files:
  p=os.path.join(base,name);s=os.lstat(p)
  assert s.st_uid==0 and s.st_gid==0, 'Runtime not owned by root'
  if stat.S_ISLNK(s.st_mode):
   assert os.path.realpath(p).startswith(release+os.sep), 'External runtime symlink'
  else:
   assert not (s.st_mode & (0o022|stat.S_ISUID|stat.S_ISGID)), 'Unsafe runtime permissions'
PY
  cmp -s "$source_dir/.env" /etc/kuvi/backend.env || fail 'Prepared environment differs from the source; review before resuming.'
  release=$(readlink -f /opt/kuvi-api/current)
  cmp -s "$source_dir/package.json" "$release/package.json" || fail 'Prepared package differs from source.'
  for artifact in dist node_modules; do
    changes=$(rsync -rlcn --delete --out-format='%n' "$source_dir/$artifact/" "$release/$artifact/")
    [[ -z $changes ]] || fail 'Prepared runtime differs from source; review before resuming.'
  done
fi
[[ ! -e /run/systemd/system/$candidate ]] || fail 'Candidate unit already exists.'
[[ $(systemctl show "$unit" -p User --value) == miguel ]] || fail 'Unexpected current service user.'
backup="/var/lib/kuvi-service-isolation/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$backup"
install -m 600 /etc/systemd/system/kuvi-backend.service "$backup/previous.service"
switched=0
candidate_written=0
finish() {
  status=$?
  trap - EXIT
  if [[ $candidate_written == 1 ]]; then
    systemctl stop "$candidate" >/dev/null 2>&1 || true
    rm -f -- "/run/systemd/system/$candidate"
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl reset-failed "$candidate" >/dev/null 2>&1 || true
  fi
  if [[ $status != 0 && $switched == 1 ]]; then
    install -m 644 "$backup/previous.service" /etc/systemd/system/kuvi-backend.service
    systemctl daemon-reload
    systemctl restart "$unit" >/dev/null 2>&1 || true
    printf '%s\n' 'Installation failed. Previous service configuration restored; check health before retrying.' >&2
  elif [[ $status != 0 ]]; then
    printf '%s\n' 'Installation stopped before production cutover. Prepared files/account retained for inspection.' >&2
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ $mode == --apply ]]; then
useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin kuvi-api
[[ $(id -Gn kuvi-api) == kuvi-api ]] || fail 'Unexpected supplementary groups.'
install -d -m 755 /opt/kuvi-api /opt/kuvi-api/releases
release="/opt/kuvi-api/releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 755 "$release"
# Copy only runtime artifacts. Never copy .env, ops, .git or operational keys.
rsync -a --chown=root:root "$source_dir/dist" "$source_dir/node_modules" "$source_dir/package.json" "$release/"
# Reject dependency symlinks escaping the runtime release.
/usr/bin/python3 - "$release" <<'PY'
import os,sys
root=os.path.realpath(sys.argv[1])
for base,dirs,files in os.walk(root):
    for name in dirs+files:
        p=os.path.join(base,name)
        if os.path.islink(p) and not os.path.realpath(p).startswith(root+os.sep):
            raise SystemExit('Runtime contains an external symlink; aborting.')
PY
find "$release" -type d -exec chmod 755 {} +
find "$release" -type f -exec chmod a+r,go-w,u-s,g-s {} +
ln -s "$release" /opt/kuvi-api/current
install -d -m 700 /etc/kuvi
install -m 600 "$source_dir/.env" /etc/kuvi/backend.env
fi
[[ $(id -Gn kuvi-api) == kuvi-api ]] || fail 'Unexpected supplementary groups.'
install -m 644 "$template" "$backup/isolated.service"
# Test the exact sandbox and compiled runtime on loopback before touching port 3000.
port=$(/usr/bin/python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
sed "s|^ExecStart=.*|ExecStart=/usr/bin/env PORT=$port HOST=127.0.0.1 /usr/bin/node /opt/kuvi-api/current/dist/app/server.js|" "$template" > "/run/systemd/system/$candidate"
candidate_written=1
systemctl daemon-reload
systemctl start "$candidate" >/dev/null 2>&1
health() {
  local port_to_check=$1
  /usr/bin/node --input-type=module -e '
const port=process.argv[1];let ok=false;
for(let i=0;i<30;i++){try{
 const base=`http://127.0.0.1:${port}`;
 const h=await fetch(base+"/db-health",{signal:AbortSignal.timeout(1500)});
 const a=await fetch(base+"/users/me",{signal:AbortSignal.timeout(1500)});
 if(h.status===200&&a.status===401){ok=true;break;}
}catch{}await new Promise(r=>setTimeout(r,500));}
if(!ok)process.exit(1);' "$port_to_check" >/dev/null 2>&1
}
health "$port" || fail 'Candidate failed database/authentication checks. Production remains unchanged.'
# Negative permissions tests run as the actual Linux account; no content printed.
for path in /home/miguel/.config/kuvi-database/admin.env /home/miguel/.config/kuvi-database/migration.env /home/miguel/.config/kuvi-database/backup.env /home/miguel/.config/kuvi-database/restore.env /home/miguel/kuvi-api/.env /etc/kuvi/backend.env; do
  if runuser -u kuvi-api -- test -r "$path"; then fail 'Runtime account can read a protected credential file.'; fi
done
if runuser -u kuvi-api -- test -w "$release/dist/app/server.js"; then fail 'Runtime account can modify deployed code.'; fi
runuser -u kuvi-api -- /usr/bin/python3 - <<'PY'
import socket
s=socket.socket(socket.AF_UNIX)
try:
    s.connect('/run/docker.sock')
except (PermissionError,FileNotFoundError):
    pass
else:
    raise SystemExit('Runtime account can access Docker; aborting.')
finally:
    s.close()
PY
systemctl stop "$candidate"
switched=1
install -m 644 "$template" /etc/systemd/system/kuvi-backend.service
systemctl daemon-reload
systemctl restart "$unit" >/dev/null 2>&1
health 3000 || fail 'Production failed database/authentication checks.'
[[ $(systemctl show "$unit" -p User --value) == kuvi-api ]] || fail 'Unexpected runtime user after cutover.'
printf '%s\n' 'OK: API running as kuvi-api; DB healthy; anonymous access denied; administrative credentials, Docker and deployed-code writes denied.'
printf 'Rollback unit retained at: %s/previous.service\n' "$backup"
printf '%s\n' 'No patient data or JWT keys changed. Future source/.env edits require an explicit runtime deployment.'
