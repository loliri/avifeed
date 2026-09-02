# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在此仓库中工作时提供指引。

## 项目概览

avifeed 是一个 Node.js 随机图床：监听 sourceDir → sharp 转 AVIF → HTTP 随机分发。
个人自托管（家用 Linux 服务器 `/server/avifeed`，systemd + nginx 反代，单用户），**源图目录在机械盘上**——一切涉及磁盘 IO 的改动都要考虑 HDD（随机寻道贵，readdir 便宜，stat 和读内容贵）。
已发布 1.0.0 并归档；任何改动以不破坏下列不变量为前提。

## 不变量（改代码前必读）

1. **sourceDir 运行时只读**。所有文件写操作必须走 `src/safefs.ts`，可写根只有 optimizedDir 和 manifestPath 所在目录，且 sourceDir 额外注册为禁区（deny 优先于 allow，防默认布局下 `dirname(manifestPath)` 是 sourceDir 父目录导致守卫失效），注册前 fail-closed。需要新可写根用 `initSafeFs` 注册并说明理由，不许绕过守卫。`config.ts` 启动期的 `mkdirSync` 在注册前执行，属刻意豁免。
2. **manifest 只存 basename（v2）**，不存绝对路径；v1 落盘格式由 `fromJSON` 自动迁移。需要 source 绝对路径时临时 `path.join(cfg.sourceDir, sourceName)`。
3. **manifest 落盘原子**（tmp + rename），每次变更后立即 flushNow，不依赖 debounce。
4. **启动对账**：optimizedDir 与 manifest 双向一致，外加「不在当前 sourceDir 的条目」清退。无论 `scanOnStart` 真假都会 `readdir` sourceDir 一次；只有 `true` 才额外逐文件 stat 入队。「启动零接触 sourceDir」与「换目录不污染」二者取后者，是既定妥协。
5. **关闭流程 10s 强退兜底**（`forceExit` 定时器）。不许改成屏蔽后续信号——第二个 ^C 是留给用户的逃生门。
6. **optimizer 同步 IO 是默认**（`asyncIo` 开关保留）。机械盘保护，不许把异步改成默认值。

## 既定行为，勿「修复」

- sharp 解不了的源文件（如 12-bit AVIF，预构建 libheif 的限制）→ warn + 跳过。
- 大图编码 1–2 分钟属正常；`Encoding image...` 和 `size: 原 → 现 (↓%)` 两条日志是刻意的「还活着」信号，勿删。
- 请求日志分级（2xx debug / 3xx warn / 4xx、5xx error）是刻意设计。

## 已否决方向（勿再提议）

限流 / rate limiting；生产环境 JSON 日志（pino-pretty 是最终选择）；异步 IO 默认化；worker_threads 隔离编码；测试。

## 部署事实

- systemd unit `deploy/avifeed.service`：`ExecStart=/usr/local/bin/node dist/index.js`（systemd 的 ExecStart 必须绝对路径，node 不在 /usr/bin）。
- 本地资料（不入 git）：`.vscode/hist/` 为完整开发会话历史。
