#!/bin/bash
# deploy-fnos.sh — 在 Mac/任何有 ssh 的机器上执行：一键部署到飞牛 fnOS
#
# 用法:
#   bash deploy-fnos.sh <NAS地址> <SSH用户名> [Web端口，默认8630]
# 示例:
#   bash deploy-fnos.sh 192.168.1.100 myuser
#
# 连接复用（ControlMaster）：整个流程只需输入一次密码。
# 若已配置 SSH 密钥（推荐 ssh-copy-id），则全程免密。
#
# 流程: 上传项目(SSH tar 流) → Docker Compose 构建并启动 → 在 NAS 上打包 .fpk
#       → 健康检查。.fpk 之后可在「应用中心 → 手动安装」安装为飞牛原生应用。
set -euo pipefail

NAS_HOST="${1:?用法: deploy-fnos.sh <NAS地址> <SSH用户名> [端口]}"
NAS_USER="${2:?缺少 SSH 用户名}"
WEB_PORT="${3:-8630}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="~/hongguo-web"
CM="-o ControlMaster=auto -o ControlPath=/tmp/hg-deploy-ssh-%r -o ControlPersist=120 -o StrictHostKeyChecking=accept-new"

echo "==> [1/5] 上传项目到 ${NAS_USER}@${NAS_HOST}:${REMOTE_DIR}（tar 流，含内置 node_modules）"
ssh ${CM} "${NAS_USER}@${NAS_HOST}" "mkdir -p ${REMOTE_DIR}"
tar --no-xattrs -czf - -C "${ROOT}" server.js package.json node_modules vendor public deploy \
    | ssh ${CM} "${NAS_USER}@${NAS_HOST}" "tar xzf - -C ${REMOTE_DIR}"

echo "==> [2/5] Docker Compose 构建并启动（fnOS 需已安装 Docker 套件）"
if ! ssh ${CM} "${NAS_USER}@${NAS_HOST}" "docker info >/dev/null 2>&1"; then
    echo "    普通 docker 权限不可用，尝试 sudo（可能需要输入 NAS 密码）"
    ssh -t ${CM} "${NAS_USER}@${NAS_HOST}" "cd ${REMOTE_DIR}/deploy && sudo docker compose up -d --build"
else
    ssh ${CM} "${NAS_USER}@${NAS_HOST}" "cd ${REMOTE_DIR}/deploy && docker compose up -d --build"
fi

echo "==> [3/5] 在 NAS 上构建 .fpk 应用包（原生模式，供应用中心手动安装）"
ssh ${CM} "${NAS_USER}@${NAS_HOST}" "cd ${REMOTE_DIR} && bash deploy/fpk/build-fpk.sh ${REMOTE_DIR}"

echo "==> [4/5] 健康检查"
sleep 3
if curl -sf -m 8 "http://${NAS_HOST}:${WEB_PORT}/api/health" ; then
    echo ""
    echo "==> [5/5] 部署完成 ✅"
    echo "    访问:     http://${NAS_HOST}:${WEB_PORT}"
    echo "    桌面图标: 应用中心 → 手动安装 → 上传 NAS 上 ${REMOTE_DIR}/hongguo.fpk"
else
    echo "!! 健康检查未通过，请到 NAS 上查看: docker logs hongguo-web"
    exit 1
fi
