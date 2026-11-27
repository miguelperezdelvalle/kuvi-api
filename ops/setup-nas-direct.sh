#!/usr/bin/env bash
# Administrator bootstrap only. The NAS password is entered in the operator's terminal.
set -Eeuo pipefail
umask 077
fail(){ printf '%s\n' "$1" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Run with sudo in your terminal. Do not share passwords in chat.'
[[ $# -ge 2 && $# -le 3 ]] || fail 'Usage: setup-nas-direct.sh NAS_IPV4 SHARE [STANDARD_USER]'
nas_host=$1
nas_share=$2
nas_user=${3:-kuvi_backup}
[[ $nas_share =~ ^[A-Za-z0-9_-]{1,64}$ && $nas_user =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || fail 'Use a simple share and standard-user name.'
[[ $nas_user != admin && $nas_user != root && $nas_user != administrator ]] || fail 'Use a dedicated standard NAS account.'
python3 - "$nas_host" <<'PY'
import ipaddress,sys
a=ipaddress.IPv4Address(sys.argv[1])
assert a.is_private and not a.is_loopback, 'A private LAN address is required'
PY
base=/home/miguel/kuvi-api
config_dir=/home/miguel/.config/kuvi-backup
mountpoint=/mnt/kuvi-nas
mount_unit=$(systemd-escape --path --suffix=mount "$mountpoint")
auto_unit=$(systemd-escape --path --suffix=automount "$mountpoint")
[[ -f $base/ops/nas-push.mjs && -f $config_dir/config.json ]] || fail 'Install and review the NAS transfer scripts first.'
for target in /etc/kuvi-nas "$mountpoint" "$config_dir/nas-direct.json" "/etc/systemd/system/$mount_unit" "/etc/systemd/system/$auto_unit"; do
  [[ ! -e $target && ! -L $target ]] || fail 'An existing NAS setup was found. Review it before replacing anything.'
done
if ! command -v mount.cifs >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y cifs-utils
fi
nas_uid=$(id -u miguel)
nas_gid=$(id -g miguel)
printf 'NAS password for standard user %s (not your Ubuntu password): ' "$nas_user"
IFS= read -r -s nas_password
printf '\nRepeat NAS password: '
IFS= read -r -s nas_confirmation
printf '\n'
[[ -n $nas_password && $nas_password == "$nas_confirmation" ]] || fail 'Passwords were empty or did not match. Nothing was configured.'
install -d -m 700 /etc/kuvi-nas
printf 'username=%s\npassword=%s\n' "$nas_user" "$nas_password" > /etc/kuvi-nas/credentials
chmod 600 /etc/kuvi-nas/credentials
unset nas_password nas_confirmation
install -d -m 700 "$mountpoint"
cat > "/etc/systemd/system/$mount_unit" <<EOF
[Unit]
Description=Kuvi backup destination on NAS (SMB3 encrypted)
Wants=network-online.target
After=network-online.target

[Mount]
What=//$nas_host/$nas_share
Where=$mountpoint
Type=cifs
Options=credentials=/etc/kuvi-nas/credentials,vers=3.1.1,seal,sec=ntlmssp,cache=none,uid=$nas_uid,gid=$nas_gid,forceuid,forcegid,file_mode=0600,dir_mode=0700,nosuid,nodev,noexec
TimeoutSec=20
EOF
cat > "/etc/systemd/system/$auto_unit" <<EOF
[Unit]
Description=Automount Kuvi NAS backup destination

[Automount]
Where=$mountpoint
TimeoutIdleSec=300

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "/etc/systemd/system/$mount_unit" "/etc/systemd/system/$auto_unit"
python3 - "$nas_host" "$nas_share" "$config_dir/nas-direct.json" <<'PY'
import json,os,pwd,sys
data={'format':'kuvi-nas-direct-config','version':1,'host':sys.argv[1],'share':sys.argv[2],
      'mountPoint':'/mnt/kuvi-nas','directory':'/mnt/kuvi-nas/database'}
with open(sys.argv[3],'x') as f:
    json.dump(data,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
u=pwd.getpwnam('miguel');os.chown(sys.argv[3],u.pw_uid,u.pw_gid);os.chmod(sys.argv[3],0o600)
PY
systemd-analyze verify "/etc/systemd/system/$mount_unit" "/etc/systemd/system/$auto_unit"
systemctl daemon-reload
systemctl enable --now "$auto_unit"
if ! runuser -u miguel -- /usr/bin/node "$base/ops/nas-push.mjs" "$config_dir/config.json" "$config_dir/nas-direct.json"; then
  fail 'NAS setup saved, but the initial copy failed. Existing backups and the API are unchanged. Review mount/authentication before retrying; do not rerun this bootstrap over existing files.'
fi
printf '%s\n' 'OK: direct encrypted Ubuntu-to-NAS copy verified. Credentials are root-only; no API secrets or patient decryption keys were copied. The assistant can now activate the 12-hour cron and retire the laptop NAS transfer.'
