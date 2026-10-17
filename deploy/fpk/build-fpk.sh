#!/bin/bash
# build-fpk.sh — 在飞牛 fnOS 上执行：把本项目打成 .fpk 应用包（原生模式，无 Docker）
#
# 用法（在飞牛上）:
#   bash deploy/fpk/build-fpk.sh ~/hongguo-web
# 产物: ~/hongguo-web/hongguo.fpk → 飞牛「应用中心 → 手动/本地安装」上传安装
#
# 依赖: curl、fnpack（脚本自动从飞牛静态源下载，含 SHA-256 校验）
set -euo pipefail

SRC_DIR="${1:?用法: build-fpk.sh <项目根目录，含 server.js/vendor/public/node_modules>}"
SRC_DIR="$(cd "${SRC_DIR}" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"   # .../deploy/fpk
FNPACK_VERSION="1.2.1"
FNPACK_DIR="${HOME}/.local/bin"

# 按飞牛架构选择 fnpack（SHA-256 与 9router-fnos 工程记录一致）
case "$(uname -m)" in
    aarch64|arm64)
        FNPACK_BIN="fnpack-${FNPACK_VERSION}-linux-arm64"
        FNPACK_SHA256="aad9e16b101267d30017f39ab969e3c085fbce209716f8bd3b1e167eaf15e0cf" ;;
    *)
        FNPACK_BIN="fnpack-${FNPACK_VERSION}-linux-amd64"
        FNPACK_SHA256="72d2a4095da676b64510b023731a227b369d80f8079bc45ff8a2f802ec0480c1" ;;
esac

echo "[1/4] 准备 fnpack..."
mkdir -p "${FNPACK_DIR}"
if [ ! -x "${FNPACK_DIR}/fnpack" ]; then
    curl -fsSL -o "${FNPACK_DIR}/fnpack" "https://static2.fnnas.com/fnpack/${FNPACK_BIN}"
    echo "${FNPACK_SHA256}  ${FNPACK_DIR}/fnpack" | sha256sum -c -
    chmod +x "${FNPACK_DIR}/fnpack"
fi
export PATH="${FNPACK_DIR}:${PATH}"

echo "[2/4] 组装打包目录..."
STAGE="$(mktemp -d /tmp/hongguo-fpk-XXXXXX)"
# 拷贝 fpk 骨架（manifest/cmd/app/config/ICON）
cp -R "${HERE}/manifest" "${HERE}/cmd" "${HERE}/config" "${HERE}/ICON.PNG" "${HERE}/ICON_256.PNG" "${STAGE}/"
mkdir -p "${STAGE}/app/ui"
cp -R "${HERE}/app/ui/." "${STAGE}/app/ui/"
# 同步应用本体（离线自足：内置 node_modules，纯 JS 依赖，任何架构可跑）
mkdir -p "${STAGE}/app/server"
cp "${SRC_DIR}/server.js" "${SRC_DIR}/package.json" "${STAGE}/app/server/"
cp -R "${SRC_DIR}/vendor" "${STAGE}/app/server/vendor"
cp -R "${SRC_DIR}/public" "${STAGE}/app/server/public"
cp -R "${SRC_DIR}/node_modules" "${STAGE}/app/server/node_modules"
# 关键：清除全部符号链接（npm 的 .bin 开发工具链接会让 fnOS 文件监控产生
# "Too many levels of symbolic links" 错误并导致 APP_INSTALL_FAILED；运行时不需要它们）
rm -rf "${STAGE}/app/server/node_modules/.bin"
find "${STAGE}/app/server/node_modules" -type l -delete 2>/dev/null || true
LINKS=$(find "${STAGE}/app/server/node_modules" -type l 2>/dev/null | wc -l)
echo "  残留符号链接: ${LINKS} 个"

echo "[3/4] fnpack 打包..."
export TMPDIR="$(mktemp -d /tmp/hongguo-fnk-XXXXXX)"
cd "${STAGE}"
fnpack build -d .
mv hongguo.fpk "${SRC_DIR}/hongguo.fpk"

echo "[4/4] 完成"
echo "  产物: ${SRC_DIR}/hongguo.fpk"
echo "  安装: 飞牛桌面 → 应用中心 → 手动安装（本地安装）→ 上传该 .fpk"
