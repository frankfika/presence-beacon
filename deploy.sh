#!/usr/bin/env bash
#
# 在岗哨 · 一键部署（Linux / systemd / Caddy 自动 HTTPS）
#
#   sudo ./deploy.sh --domain pb.yourcompany.com --email you@yourcompany.com
#
# 幂等：可以重复跑，会更新配置但不会覆盖已有数据库。
# 先看要做什么：加 --dry-run（不碰系统任何文件）
#
set -euo pipefail

DOMAIN=""
EMAIL=""
PORT="8080"
INSTALL_DIR="/opt/presence-beacon"
SERVICE="presence-beacon"
DRY_RUN=0
SKIP_CADDY=0

usage() {
  cat <<'EOF'
用法:
  sudo ./deploy.sh --domain <域名> --email <邮箱> [选项]

选项:
  --domain <域名>    对外访问的域名，例如 pb.yourcompany.com（必填）
  --email <邮箱>     邮箱，用于 Caddy 申请 HTTPS 证书（必填）
  --port <端口>      应用监听端口，默认 8080
  --dir <路径>       安装目录，默认 /opt/presence-beacon
  --no-caddy         不装 Caddy（自己已经有反向代理）
  --dry-run          只打印要做什么，不改系统任何文件
  -h, --help         看这个

跑完:
  1. 管理员口令在 $INSTALL_DIR/data/.admin-password
  2. 打开 https://<域名>/admin 用它登录
  3. 旧安卓手机打开 https://<域名>/t/<终端密钥> 加到主屏幕
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email)  EMAIL="$2";  shift 2 ;;
    --port)   PORT="$2";   shift 2 ;;
    --dir)    INSTALL_DIR="$2"; shift 2 ;;
    --no-caddy) SKIP_CADDY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不认识的参数：$1"; usage; exit 1 ;;
  esac
done

[[ -n "$DOMAIN" ]] || { echo "缺少 --domain"; usage; exit 1; }
[[ -n "$EMAIL" ]]  || { echo "缺少 --email"; usage; exit 1; }

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
step() { echo "  → $*"; }

# 真正执行一条命令；dry-run 下只打印
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

# 写一个文件；dry-run 下只打印路径和内容摘要
write_file() {
  local path="$1"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [dry-run] 会写 $path"
  else
    cat > "$path"
    echo "  已写 $path"
  fi
}

say "在岗哨部署 → https://$DOMAIN"

# ── 1. 环境检查 ───────────────────────────────────────────────
say "[1/7] 检查环境"

NODE_OK=1
if command -v node >/dev/null; then
  NODE_VER=$(node -v | sed 's/v//')
  NODE_MAJOR=${NODE_VER%%.*}
  NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)
  if [[ "$NODE_MAJOR" -gt 22 ]] || { [[ "$NODE_MAJOR" -eq 22 ]] && [[ "$NODE_MINOR" -ge 13 ]]; }; then
    echo "  ✓ Node $NODE_VER"
  else
    NODE_OK=0
    echo "  ✗ Node $NODE_VER 太老，需要 ≥ 22.13（用了内置 node:sqlite）"
  fi
else
  NODE_OK=0
  echo "  ✗ 没装 Node.js"
fi
[[ $NODE_OK -eq 1 ]] || {
  echo "  装法：curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  [[ $DRY_RUN -eq 1 ]] || exit 1
}

if command -v systemctl >/dev/null; then
  echo "  ✓ systemd 可用"
else
  echo "  ✗ 没有 systemd。这脚本只支持 systemd 的 Linux（Debian/Ubuntu/CentOS 等）"
  [[ $DRY_RUN -eq 1 ]] || exit 1
fi

# ── 2. 放代码 ────────────────────────────────────────────────
say "[2/7] 准备代码"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "  已有 git 仓库，更新"
  run git -C "$INSTALL_DIR" pull --ff-only
elif [[ -f "$PWD/server/index.js" ]]; then
  echo "  从当前目录复制"
  run mkdir -p "$INSTALL_DIR"
  run rsync -a --exclude node_modules --exclude data --exclude .git "$PWD/" "$INSTALL_DIR/"
else
  echo "  从 GitHub 下载 v1.0.0"
  run mkdir -p "$INSTALL_DIR"
  run bash -c "curl -fsSL 'https://github.com/frankfika/presence-beacon/archive/refs/tags/v1.0.0.tar.gz' | tar -xz --strip-components=1 -C '$INSTALL_DIR'"
fi
echo "  安装目录：$INSTALL_DIR"

# ── 3. 依赖 ──────────────────────────────────────────────────
say "[3/7] 安装依赖"
run bash -c "cd '$INSTALL_DIR' && npm ci --omit=dev --no-audit --no-fund"

# ── 4. 配置 ──────────────────────────────────────────────────
say "[4/7] 写配置"
run mkdir -p "$INSTALL_DIR/data"
run chmod 700 "$INSTALL_DIR/data"

ENV_FILE="$INSTALL_DIR/.env"
ENV_CONTENT="\
# 在岗哨配置 — 由 deploy.sh 生成于 $(date -u +%Y-%m-%dT%H:%M:%SZ)
PORT=$PORT
RP_ID=$DOMAIN
APP_ORIGIN=https://$DOMAIN
DB_FILE=$INSTALL_DIR/data/presence.db
TZ_OFFSET_MINUTES=480
# TRUST_PROXY=1
# REPORT_WEBHOOK_URL=
"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  [dry-run] 会写 $ENV_FILE："
  echo "$ENV_CONTENT" | sed 's/^/      /'
else
  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
    echo "  旧配置已备份到 $ENV_FILE.bak.*"
  fi
  printf '%s' "$ENV_CONTENT" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  已写 $ENV_FILE"
fi

# ── 5. systemd ───────────────────────────────────────────────
say "[5/7] 注册 systemd 服务"
UNIT="/etc/systemd/system/$SERVICE.service"
UNIT_CONTENT="\
[Unit]
Description=在岗哨 Presence Beacon
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/env node --env-file-if-exists=$INSTALL_DIR/.env $INSTALL_DIR/server/index.js
Restart=always
RestartSec=3
User=presence-beacon
Group=presence-beacon
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/data

[Install]
WantedBy=multi-user.target
"
write_file "$UNIT" <<< "$UNIT_CONTENT"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "  [dry-run] 建 presence-beacon 用户 + systemctl enable --now $SERVICE"
else
  id -u presence-beacon >/dev/null 2>&1 \
    || useradd --system --no-create-home --shell /usr/sbin/nologin presence-beacon
  chown -R presence-beacon:presence-beacon "$INSTALL_DIR/data"
  chown root:root "$INSTALL_DIR/.env"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE"
  sleep 3
  if systemctl is-active --quiet "$SERVICE"; then
    echo "  ✓ 服务已启动"
  else
    echo "  ✗ 服务没起来，日志："
    journalctl -u "$SERVICE" -n 30 --no-pager || true
    exit 1
  fi
fi

# ── 6. Caddy / HTTPS ─────────────────────────────────────────
if [[ $SKIP_CADDY -eq 0 ]]; then
  say "[6/7] 配置 HTTPS（Caddy）"

  if command -v caddy >/dev/null; then
    echo "  ✓ Caddy 已装"
  elif [[ $DRY_RUN -eq 1 ]]; then
    echo "  [dry-run] 会安装 Caddy"
  else
    echo "  安装 Caddy…"
    apt-get update -qq
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y caddy
  fi

  CADDYFILE="/etc/caddy/Caddyfile"
  if [[ $DRY_RUN -eq 1 ]]; then
    if [[ -f "$CADDYFILE" ]] && grep -q "$DOMAIN" "$CADDYFILE" 2>/dev/null; then
      echo "  [dry-run] $CADDYFILE 里已经有 $DOMAIN，跳过"
    else
      echo "  [dry-run] 会往 $CADDYFILE 追加："
      echo "      $DOMAIN {"
      echo "          reverse_proxy 127.0.0.1:$PORT"
      echo "      }"
    fi
  else
    [[ -f "$CADDYFILE" ]] || { mkdir -p /etc/caddy; : > "$CADDYFILE"; }
    if grep -q "$DOMAIN" "$CADDYFILE" 2>/dev/null; then
      echo "  $CADDYFILE 里已经有 $DOMAIN，跳过"
    else
      cat >> "$CADDYFILE" <<EOF

$DOMAIN {
    reverse_proxy 127.0.0.1:$PORT
}
EOF
      echo "  已写入 $CADDYFILE"
    fi
    systemctl reload caddy || systemctl restart caddy
    sleep 4
  fi
else
  say "[6/7] 跳过 Caddy（--no-caddy）"
fi

# ── 7. 收尾 ──────────────────────────────────────────────────
say "[7/7] 收尾"
PW_FILE="$INSTALL_DIR/data/.admin-password"
if [[ -f "$PW_FILE" ]]; then
  echo "  管理员口令（现在就存下来，登录后可以在网页上改）："
  echo "    $(cat "$PW_FILE")"
else
  echo "  口令文件还没生成，看日志：journalctl -u $SERVICE -n 20"
fi

echo ""
echo "  ⚠  域名要先解析到这台机器的公网 IP，HTTPS 证书才能签出来。"
echo "     查：dig +short $DOMAIN"
echo ""
echo "  下一步："
echo "    1. 打开 https://$DOMAIN/admin 登录"
echo "    2. 「员工」页添加员工，生成邀请码 + 员工码"
echo "    3. 「终端」页添加终端，把链接在旧安卓机上打开"
echo "    4. 照《使用手册》3.6 完整演练一遍"
echo ""
echo "  自检：cd $INSTALL_DIR && node scripts/doctor.js https://$DOMAIN"
echo "  备份：cd $INSTALL_DIR && npm run backup"
echo ""
