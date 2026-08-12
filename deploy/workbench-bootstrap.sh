#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this script as root in Alibaba Cloud ECS Workbench.' >&2
  exit 1
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_path="${DEPLOY_PATH:-/var/www/mosshqq/upload-cloudbase}"
service_name='cloudbase-public-file-proxy.service'
nginx_config='/etc/nginx/conf.d/cloudbase-public-file-proxy.conf'
env_file="$deploy_path/shared/app.env"

if ! id deploy >/dev/null 2>&1; then
  echo 'The deploy user does not exist; create it through the ECS deployment policy first.' >&2
  exit 1
fi

command -v node >/dev/null || { echo 'Node.js is required.' >&2; exit 1; }
command -v nginx >/dev/null || { echo 'Nginx is required.' >&2; exit 1; }
command -v systemctl >/dev/null || { echo 'systemd is required.' >&2; exit 1; }

install -d -o deploy -g deploy -m 0755 \
  "$deploy_path" "$deploy_path/releases" "$deploy_path/shared"

if [ ! -f "$env_file" ]; then
  install -o deploy -g deploy -m 0600 "$repo_root/deploy/app.env.example" "$env_file"
fi

if [ -e "$nginx_config" ] && ! grep -q 'CloudBase public file proxy' "$nginx_config"; then
  echo "Refusing to overwrite existing Nginx config: $nginx_config" >&2
  exit 1
fi

if nginx -T 2>/dev/null | grep -Eq 'server_name[[:space:]]+8\.130\.116\.192([[:space:];]|$)' \
  && [ ! -e "$nginx_config" ]; then
  echo 'Nginx already has a server block for 8.130.116.192; resolve the route before installing this proxy.' >&2
  exit 1
fi

install -o root -g root -m 0644 \
  "$repo_root/deploy/systemd/$service_name" \
  "/etc/systemd/system/$service_name"
install -o root -g root -m 0644 \
  "$repo_root/deploy/nginx/cloudbase-public-file-proxy.conf" \
  "$nginx_config"

cat > /etc/sudoers.d/cloudbase-public-file-proxy <<'SUDOERS'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart cloudbase-public-file-proxy.service
SUDOERS
chmod 0440 /etc/sudoers.d/cloudbase-public-file-proxy
visudo -cf /etc/sudoers.d/cloudbase-public-file-proxy

nginx -t
systemctl daemon-reload
systemctl enable "$service_name"
systemctl reload nginx

echo "Bootstrap complete. Set CLOUDBASE_SERVICE_ROLE_KEY in $env_file, then run the GitHub Actions deployment workflow."
