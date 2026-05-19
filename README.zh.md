# avifeed

📖 README: **[English](README.md)** | **简体中文**

**avifeed** 把一个图片目录变成一个低带宽的随机图接口。把原图扔进目录，服务端会在后台自动转码成 AVIF，实时跟随文件增删保持同步，每次 `GET /` 随机返回一张——以远小于原图的字节数。

它和"随便挑一个文件返回"的一行脚本最大的区别：

- **自动 AVIF 压缩**：每张图都用 sharp + libvips 重编码，相比 JPEG/PNG 通常能小 **70–80%**，肉眼看不出质量差。你上传原图，访客拿到的是 AVIF。
- **自动同步**：文件监听实时跟踪源目录的新增、修改、删除。编码会去抖避开半写状态的文件、对同一文件的并发任务自动去重、manifest 原子落盘——崩溃也不会让磁盘和清单不一致。
- **源文件天然受保护**：`sourceDir` 被当作严格只读。代码里所有写文件操作都走一个守卫（`src/safefs.ts`），目标只要不在登记的输出目录之内就直接抛错。哪怕将来代码出 bug，也碰不到你的原图。
- **缓存友好**：输出文件名带内容哈希，`/images/<name>.<hash>.avif` 可以加一年 `immutable` 缓存头。`GET /` 每次返回一张新随机图；`GET /?redirect=1` 302 跳到稳定 URL，让浏览器把字节缓存下来。

---

## 功能

- 把图片扔进目录，自动转码为 AVIF
- 输出文件名带内容哈希（`name.<sha256前缀>.avif`），可以永久缓存
- `GET /` 每次返回一张随机图片
- `GET /?redirect=1` 302 跳转到稳定的内容 URL，让浏览器缓存
- `/images/:filename` 带 ETag 和 `Cache-Control: immutable`
- chokidar 实时监听文件的新增、修改、删除
- manifest 原子写盘，重启不需要重新编码
- 源目录运行时只读，由写路径守卫强制
- 内置 `/healthz`、`/readyz`、`/metrics` 端点
- 优雅关闭：退出前 drain 编码队列（带 10 秒强退兜底）
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

### `scanOnStart` 详解

这个开关只控制**启动时是否扫描 `sourceDir`**，不影响 manifest 与 `optimizedDir` 的对账——后者无论开关如何始终都会执行。

每次启动，无论 `scanOnStart` 是什么值：

- 都会从磁盘读取 manifest。
- 都会双向对账 `optimizedDir`：
  - manifest 里有记录但 AVIF 文件已不存在 → 删该条记录；
  - `optimizedDir` 里有 AVIF 文件但 manifest 没记录 → 删该 AVIF 文件。
- **完全不读、不 stat、不碰 `sourceDir`**。（这点对源目录在慢速磁盘 / 可移动盘 / 网络盘上、启动时可能还没就绪的场景很有用。）

`scanOnStart=true` 时，额外执行：

- 列出 `sourceDir` 下所有图片文件并 `stat` 一遍。
- 凡是 manifest 里没有的、或者大小/修改时间和 manifest 记录不一致的文件，都入队等待编码。

`scanOnStart=false`（默认）时：

- 启动期完全不碰 `sourceDir`。服务运行起来后，新增/变更只能靠 watcher 捕获。**服务停机期间放进去的文件**不会被自动处理，需要再次 touch（修改）一下才会触发编码。

---

## 部署

`deploy/` 目录下有一个带基础 hardening 的 systemd unit，安装步骤见 [`deploy/README.md`](deploy/README.md)。

建议放在反向代理（nginx、caddy）后面处理 TLS 和限速。

---

## 工作原理

1. **启动清理**：读取 manifest，与 `optimizedDir` 双向对账：删掉 AVIF 已不存在的 manifest 条目，删掉 manifest 不认识的 AVIF 文件。`scanOnStart=true` 时再额外扫描 `sourceDir`，把新增或变更的文件入队。
2. **监听**：chokidar 非递归监听源目录，按扩展名白名单过滤，隐藏文件和临时文件自动跳过。
3. **稳定检测**：编码前轮询文件大小，连续 `stabilizeMs` 毫秒不变才认为写入完成，避免读到未写完的文件。
4. **编码**：sharp 转 AVIF，先写临时文件再 rename，保证原子性。同一源文件再次变更时，正在进行的编码会被 abort，新任务入队。
5. **持久化**：每次 manifest 变更后立即同步落盘（tmp 文件 + rename），崩溃不会留下不一致状态。

---

## 源目录是只读的

avifeed 把 `sourceDir` 当作严格**只读**输入：服务端只对源目录里的文件做 `stat`、读取、监听，**绝不会**创建、重命名、删除或修改源文件。所有写操作都只发生在 `optimizedDir` 和 `manifestPath` 上。

这一约束不只是口头约定，而是在运行时强制执行的。代码里所有文件系统写操作都走一个小封装（`src/safefs.ts`），它会解析目标路径，如果不在启动时登记的可写根目录（`optimizedDir` 以及 `manifestPath` 所在目录）下，会直接抛出 `EWRITEFORBIDDEN` 错误。今后哪怕有人改错代码、不小心把写操作指向了 `sourceDir`，也会立即报错，不会悄悄破坏你的原图。

---

## 为什么用 AVIF？

AVIF（AV1 图像文件格式）是目前主流浏览器中压缩率最高的图片格式：

- **比 JPEG 小 30–50%**，视觉质量相当
- **比 WebP 更好**，在复杂渐变和细节上表现更优
- 原生支持 **HDR 和宽色域**
- Chrome、Firefox、Safari 16+、所有现代移动浏览器均原生支持

用 AVIF 意味着更少的带宽、更快的加载速度、更低的存储成本，且肉眼看不出质量差异。

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
  safefs.ts       写路径守卫，拒绝写入可写根之外的位置
deploy/
  avifeed.service systemd unit
  README.md       部署指南
config.example.json
```

---

## 许可证

ISC
