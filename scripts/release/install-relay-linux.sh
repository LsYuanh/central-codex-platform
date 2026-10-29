#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
# Explicit initial deployment, compatible with systemd 219. Never reload or
# rewrite existing web services, shared firewall rules, or global TLS trust.
set -euo pipefail
export LC_ALL=C
test "$#" = 3
stage=$1
public_ip=$2
owner=$3
[[ "$stage" =~ ^/opt/yuanzhou-relay-staging-[0-9]{8}$ ]]
[[ "$owner" =~ ^yuanzhou-relay-production-[0-9]{8}$ ]]
[[ "$public_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
test "$(readlink -f "$stage")" = "$stage"
test "$(cat "$stage/ownership-marker")" = "$owner"
test "$(id -u)" = 0
test ! -e /opt/yuanzhou-relay
test ! -e /etc/yuanzhou-relay
test ! -e /etc/systemd/system/yuanzhou-relay.service
test ! -e /etc/systemd/system/yuanzhou-relay-renew.timer
test "$(stat -c %a "$stage/admission.token")" = 600
token=$(cat "$stage/admission.token")
[[ "$token" =~ ^[A-Za-z0-9_-]{43}$ ]]
printf '%s  %s\n' 75254641e3fad7fcbac6dee4d485556fbe06ef708340a9d8810469270ba626b8 "$stage/relay.tar.gz" | sha256sum -c -
test "$($stage/iroh-relay --version)" = 'iroh-relay 1.4.1'
python3 - "$public_ip" <<'PY'
import ipaddress,socket,sys
assert ipaddress.ip_address(sys.argv[1]).version==4
for address,port in [('0.0.0.0',38443),('127.0.0.1',38444),('127.0.0.1',39090)]:
    with socket.socket() as sock: sock.bind((address,port))
PY
if getent passwd yuanzhou-relay >/dev/null; then echo RELAY_USER_ALREADY_EXISTS >&2; exit 1; fi
if firewall-cmd --zone=public --query-port=38443/tcp; then exit 1; fi
if firewall-cmd --permanent --zone=public --query-port=38443/tcp; then exit 1; fi
useradd --system --no-create-home --home-dir /nonexistent --shell /sbin/nologin yuanzhou-relay
umask 077
mkdir /opt/yuanzhou-relay /etc/yuanzhou-relay
install -o root -g root -m 755 "$stage/iroh-relay" /opt/yuanzhou-relay/iroh-relay
printf '%s\n' "$owner" > /etc/yuanzhou-relay/ownership-marker
chmod 755 /opt/yuanzhou-relay
cat > /etc/yuanzhou-relay/ca.cnf <<'CONF'
[req]
distinguished_name=dn
x509_extensions=ca
prompt=no
[dn]
CN=YuanZhou private relay CA
[ca]
basicConstraints=critical,CA:true,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
CONF
cat > /etc/yuanzhou-relay/server.ext <<CONF
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=IP:$public_ip,IP:127.0.0.1
CONF
openssl ecparam -name prime256v1 -genkey -noout -out /etc/yuanzhou-relay/ca.key
openssl req -new -x509 -sha256 -days 3650 -key /etc/yuanzhou-relay/ca.key -out /etc/yuanzhou-relay/ca.pem -config /etc/yuanzhou-relay/ca.cnf
openssl ecparam -name prime256v1 -genkey -noout -out /etc/yuanzhou-relay/relay.key
openssl req -new -sha256 -key /etc/yuanzhou-relay/relay.key -subj '/CN=YuanZhou authenticated relay' -out /etc/yuanzhou-relay/relay.csr
openssl x509 -req -sha256 -days 397 -in /etc/yuanzhou-relay/relay.csr -CA /etc/yuanzhou-relay/ca.pem -CAkey /etc/yuanzhou-relay/ca.key -CAcreateserial -extfile /etc/yuanzhou-relay/server.ext -out /etc/yuanzhou-relay/relay.crt
cat > /etc/yuanzhou-relay/relay.toml <<CONF
enable_relay = true
enable_quic_addr_discovery = false
http_bind_addr = "127.0.0.1:38444"
enable_metrics = true
metrics_bind_addr = "127.0.0.1:39090"
access.shared_token = ["$token"]
[tls]
https_bind_addr = "0.0.0.0:38443"
cert_mode = "Manual"
manual_cert_path = "/etc/yuanzhou-relay/relay.crt"
manual_key_path = "/etc/yuanzhou-relay/relay.key"
CONF
unset token
chgrp yuanzhou-relay /etc/yuanzhou-relay /etc/yuanzhou-relay/relay.{toml,crt,key}
chmod 750 /etc/yuanzhou-relay
chmod 640 /etc/yuanzhou-relay/relay.{toml,crt,key}
cat > /etc/systemd/system/yuanzhou-relay.service <<'UNIT'
[Unit]
Description=YuanZhou authenticated HTTPS relay
Wants=network-online.target
After=network-online.target
[Service]
Type=simple
User=yuanzhou-relay
Group=yuanzhou-relay
ExecStart=/opt/yuanzhou-relay/iroh-relay --config-path /etc/yuanzhou-relay/relay.toml
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
CapabilityBoundingSet=
UMask=0077
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
UNIT
# Keep the private CA stable, so automatically renewed leaves remain trusted by
# existing pairing bundles. The root key is readable by root only, not the relay.
cat > /opt/yuanzhou-relay/renew-certificate.sh <<'RENEW'
#!/bin/bash
set -euo pipefail
umask 077
cd /etc/yuanzhou-relay
openssl x509 -in relay.crt -checkend 2592000 -noout >/dev/null && exit 0
openssl x509 -in ca.pem -checkend 34560000 -noout >/dev/null
trap 'rm -f relay.next.crt' EXIT
openssl x509 -req -sha256 -days 397 -in relay.csr -CA ca.pem -CAkey ca.key -CAserial ca.srl -extfile server.ext -out relay.next.crt
openssl verify -CAfile ca.pem relay.next.crt
chown root:yuanzhou-relay relay.next.crt
chmod 640 relay.next.crt
mv -f relay.next.crt relay.crt
systemctl restart yuanzhou-relay.service
RENEW
chmod 700 /opt/yuanzhou-relay/renew-certificate.sh
cat > /etc/systemd/system/yuanzhou-relay-renew.service <<'UNIT'
[Unit]
Description=Renew YuanZhou relay leaf when fewer than 30 days remain
[Service]
Type=oneshot
ExecStart=/opt/yuanzhou-relay/renew-certificate.sh
UMask=0077
UNIT
cat > /etc/systemd/system/yuanzhou-relay-renew.timer <<'UNIT'
[Unit]
Description=Daily YuanZhou relay certificate expiry check
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
UNIT
openssl verify -CAfile /etc/yuanzhou-relay/ca.pem /etc/yuanzhou-relay/relay.crt
systemd-analyze verify /etc/systemd/system/yuanzhou-relay.service /etc/systemd/system/yuanzhou-relay-renew.service /etc/systemd/system/yuanzhou-relay-renew.timer
systemctl daemon-reload
systemctl enable yuanzhou-relay.service yuanzhou-relay-renew.timer
systemctl start yuanzhou-relay.service yuanzhou-relay-renew.timer
sleep 2
systemctl is-active yuanzhou-relay.service yuanzhou-relay-renew.timer
curl --fail --silent --show-error --cacert /etc/yuanzhou-relay/ca.pem https://127.0.0.1:38443/ -o /dev/null
# Add only this port, without firewall reload or changing existing rule sets.
firewall-cmd --permanent --zone=public --add-port=38443/tcp
firewall-cmd --zone=public --add-port=38443/tcp
systemctl start yuanzhou-relay-renew.service
openssl x509 -in /etc/yuanzhou-relay/relay.crt -noout -dates
cat /etc/yuanzhou-relay/ca.pem
printf 'RELAY_DEPLOYED_TLS_AUTH_AUTOSTART_RENEWAL\n'
