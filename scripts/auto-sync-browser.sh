#!/bin/bash
set -euo pipefail

export PATH="/Users/gosick/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

REPO_DIR="/Users/gosick/Documents/GitHub 礼品卡价格监控网站"
LOCK_DIR="/tmp/apple-card-monitor-sync.lock"

# 防止重入；若锁目录超过 20 分钟（1200 秒）视为遗留死锁自动清理
if [ -d "$LOCK_DIR" ]; then
  LOCK_MTIME=$(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)
  NOW_TS=$(date +%s)
  if [ $((NOW_TS - LOCK_MTIME)) -gt 1200 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 已有同步任务正在运行，本次跳过"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

cd "$REPO_DIR"

# 同步远端提交，避免推送冲突
git -c http.version=HTTP/1.1 pull --rebase --autostash origin main >/dev/null 2>&1 || true

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始同步 Bitrefill & Kryptomate 浏览器快照..."
set +e
node scripts/sync-browser.mjs --only-cache
SYNC_CODE=$?
set -e

if [ "$SYNC_CODE" -eq 2 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 触发 Cloudflare 人机验证，等待用户在 ego-browser 中点击验证"
  osascript -e 'display notification "Bitrefill 或 Kryptomate 触发人机验证，请在 ego-browser 中点击验证" with title "Apple 礼品卡监控"' >/dev/null 2>&1 || true
  exit 0
elif [ "$SYNC_CODE" -ne 0 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 同步失败，退出码: $SYNC_CODE"
  exit "$SYNC_CODE"
fi

if ! git diff --quiet docs/data/browser-cache.json; then
  git add docs/data/browser-cache.json
  git commit -m "chore: 定时同步 Bitrefill & Kryptomate 浏览器快照"
fi

# 检查是否存在待推送提交（含上次偶发网络失败遗留的提交）
AHEAD_COUNT=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
if [ "$AHEAD_COUNT" -eq 0 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 浏览器快照无变化且无待推送提交，跳过推送"
  exit 0
fi

PUSH_OK=0
for i in 1 2 3; do
  if git -c http.version=HTTP/1.1 push origin main; then
    PUSH_OK=1
    break
  fi
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 第 $i 次推送失败，5秒后重试..."
  sleep 5
  git -c http.version=HTTP/1.1 pull --rebase --autostash origin main >/dev/null 2>&1 || true
done

if [ "$PUSH_OK" -ne 1 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 推送失败，已保留本地快照提交，等待下轮重推"
  exit 1
fi
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 已推送最新浏览器快照，将自动触发云端重新采集并部署"
