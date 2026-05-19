# avifeed

**avifeed** 是一个 Node.js HTTP 服务器，监听一个图片目录，自动把图片转码为 [AVIF](https://aomediacodec.github.io/av1-avif/) 格式，每次请求随机返回一张。

> English documentation: [README.md](README.md)

---

## 为什么用 AVIF？

AVIF（AV1 图像文件格式）是目前主流浏览器中压缩率最高的图片格式：

- **比 JPEG 小 30–50%**，视觉质量相当
- **比 WebP 更好**，在复杂渐变和细节上表现更优
- 原生支持 **HDR 和宽色域**
- Chrome、Firefox、Safari 16+、所有现代移动浏览器均原生支持

用 AVIF 意味着更少的带宽、更快的加载速度、更低的存储成本，且肉眼看不出质量差异。

---

## 功能

- 把图片扔进目录，自动转码为 AVIF
- 输出文件名带内容哈希（`name.<sha256前缀>.avif`），可以永久缓存
- `GET /` 每次返回一张随机图片
- `GET /?redirect=1` 302 跳转到稳定的内容 URL，让浏览器缓存
- `/images/:filename` 带 ETag 和 `Cache-Control: immutable`
- chokidar 实时监听文件的新增、修改、删除
- manifest 原子写盘，重启不需要重新编码
- 内置 `/healthz`、`/readyz`、`/metrics` 端点
- 优雅关闭：退出前 drain 编码队列
- 支持 `config.json` 和 `RIS_*` 环境变量配置

---

## 环境要求

- Node.js ≥ 20
- `npm install`（sharp 自带 libvips，大多数平台无需额外系统依赖）

---

## 快速开始

```sh
git clone https://github.com/<你的用户名>/avifeed.git
cd avifeed
npm install
cp config.example.json config.json   # 按需修改
npm run build
npm start
```

把图片放进 `./images/source/`，访问 `http://localhost:2333/` 即可获取随机图片。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 返回一张随机 AVIF 图片（`Cache-Control: no-store`） |
| `GET` | `/?redirect=1` | 302 跳转到内容寻址 URL |
| `GET` | `/images/:filename` | 返回指定图片，带 ETag 和一年不可变缓存 |
| `GET` | `/healthz` | 存活检查，始终返回 `{"status":"ok"}` |
| `GET` | `/readyz` | 就绪检查，验证输出目录可写，返回 manifest 条目数 |
| `GET` | `/metrics` | 纯文本指标：manifest 条目数、编码队列长度 |

---

## 配置

把 `config.example.json` 复制为 `config.json` 并修改。每个字段都有对应的 `RIS_*` 环境变量，环境变量优先级更高。

| 字段 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `port` | `RIS_PORT` | `2333` | HTTP 监听端口 |
| `sourceDir` | `RIS_SOURCE_DIR` | `./images/source` | 源图目录 |
| `optimizedDir` | `RIS_OPTIMIZED_DIR` | `./images/optimized` | AVIF 输出目录 |
| `manifestPath` | `RIS_MANIFEST_PATH` | `./images/manifest.json` | manifest 文件路径 |
| `avifQuality` | `RIS_AVIF_QUALITY` | `50` | AVIF 质量 1–100 |
| `avifEffort` | `RIS_AVIF_EFFORT` | `4` | 编码 effort 0–9（越高文件越小，越慢） |
| `watch` | `RIS_WATCH` | `true` | 是否监听源目录变更 |
| `scanOnStart` | `RIS_SCAN_ON_START` | `false` | 启动时是否完整扫描源目录 |
| `asyncIo` | `RIS_ASYNC_IO` | `false` | optimizer 是否用 `fs.promises`（默认同步，自然限流） |
| `stabilizeMs` | `RIS_STABILIZE_MS` | `200` | 文件大小持续不变多少毫秒才开始编码 |
| `stabilizePollMs` | `RIS_STABILIZE_POLL_MS` | `50` | 稳定检测轮询间隔 |
| `stabilizeTimeoutMs` | `RIS_STABILIZE_TIMEOUT_MS` | `10000` | 稳定检测超时 |
| _（仅环境变量）_ | `RIS_HASH_LENGTH` | `8` | 文件名中嵌入的 SHA-256 十六进制字符数 |
| _（仅环境变量）_ | `RIS_LOG_LEVEL` | `info` | pino 日志级别 |
| _（仅环境变量）_ | `RIS_CONFIG` | `./config.json` | 配置文件路径 |

---

## 工作原理

1. **启动清理**：读取 manifest，删除优化文件已不存在的条目，清理源文件已删除的条目。`scanOnStart=true` 时完整扫描源目录。
2. **监听**：chokidar 非递归监听源目录，按扩展名白名单过滤，隐藏文件和临时文件自动跳过。
3. **稳定检测**：编码前轮询文件大小，连续 `stabilizeMs` 毫秒不变才认为写入完成，避免读到未写完的文件。
4. **编码**：sharp 转 AVIF，先写临时文件再 rename，保证原子性。同一源文件再次变更时，正在进行的编码会被 abort，新任务入队。
5. **持久化**：每次 manifest 变更后立即同步落盘（tmp 文件 + rename），崩溃不会留下不一致状态。

---

## 部署

`deploy/` 目录下有一个带基础 hardening 的 systemd unit，安装步骤见 [`deploy/README.md`](deploy/README.md)。

建议放在反向代理（nginx、caddy）后面处理 TLS 和限速。

---

## GitHub 仓库信息填写建议

| 字段 | 建议内容 |
| --- | --- |
| **仓库名** | `avifeed` |
| **描述 (Description)** | A Node.js random image server that auto-encodes photos to AVIF and serves them over HTTP |
| **Topics / 标签** | `nodejs` `avif` `image-server` `fastify` `sharp` `self-hosted` |
| **Website** | 你的部署地址，例如 `https://img.example.com` |
| **Social preview** | 用一张 AVIF 输出图作为预览图效果不错 |

可选的 `.github/` 补充：
- `ISSUE_TEMPLATE` — bug 报告 + 功能请求模板
- `FUNDING.yml` — 赞助链接

---

## 项目结构

```
src/
  index.ts        入口，串联所有模块
  config.ts       配置加载与校验
  log.ts          pino 日志
  manifest.ts     源文件到优化文件的映射，原子持久化
  hash.ts         SHA-256 内容哈希
  watcher.ts      chokidar 封装，带扩展名过滤
  optimizer.ts    串行编码队列，支持 abort
  bootstrap.ts    启动期清理与扫描
  server.ts       fastify 路由
deploy/
  avifeed.service systemd unit
  README.md       部署指南
config.example.json
```

---

## 许可证

ISC
