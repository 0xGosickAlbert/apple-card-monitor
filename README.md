# Apple 礼品卡全球实时比价与汇率浮动监控

聚合监控 **12 大礼品卡平台**（Tamana、CryptoRefills、Coinsbee、Tokenstore、CoinGate、ByteTopup、Bitrefill、Kryptomate、Keys4Coins、BitGift、Eneba、Recharge）的全球 Apple 系列礼品卡实时售价、区间自定义面值、真实国际汇率折扣/溢价比例，以及历史价格涨跌浮动。

---

## 本地运行命令

```bash
# 1. 云端/纯接口直连采集（同时合并本地浏览器缓存）
npm run collect

# 2. 全量采集（先通过 ego-browser 采集 Kryptomate & Bitrefill 网页，再汇总其余 10 站）
npm run collect:all

# 3. 启动本地手机/电脑预览看板（默认 http://127.0.0.1:3456）
npm start
```

> **关于 `.env` 密钥**：请在项目根目录参考 `.env.example` 创建 `.env` 文件配置 `BITREFILL_API_KEY`。`.gitignore` 已忽略 `.env`，绝不会随代码上传公开。

---

## 3 步免费上线公网访问（GitHub Actions + GitHub Pages）

1. 在 GitHub 新建一个仓库（公开仓库可无限免费使用 GitHub Actions + Pages），将本项目代码推送上去：
   ```bash
   git init
   git add .
   git commit -m "feat: 初始化 Apple 礼品卡聚合监控"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<你的仓库名>.git
   git push -u origin main
   ```
2. 打开 GitHub 仓库的 **Settings → Pages**：
   - 将 **Build and deployment → Source** 选择为 **GitHub Actions**。
3. （可选）打开 **Settings → Secrets and variables → Actions → New repository secret**：
   - 添加 `BITREFILL_API_KEY`（填入您的 Bitrefill API Key）。
   - 前往 **Actions** 页面点击 **Run workflow** 即可立即生成并发布公网网址（`https://<你的用户名>.github.io/<你的仓库名>/`），此后每 15 分钟自动更新一次！

> **关于 Kryptomate / Bitrefill 网页同步**：由于部分站点部署了 Cloudflare 人机盾，可在本地电脑运行 `npm run sync:browser` 并 `git push`，云端定时任务会自动保留并持续比对您的最新快照数据。
