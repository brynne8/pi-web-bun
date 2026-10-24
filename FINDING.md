# Vinext 迁移调研

## 1. 项目背景

pi-web 是 Next.js 16 的 App Router 项目，发布为 npm 包，用户通过 `npx @agegr/pi-web` 运行。

- `next build --webpack` 是当前发布方式（Turbopack build 产生符号链接，无法分发）。
- webpack 构建慢（分钟级），Turbopack 14.7s 但产物含 6 个软链。
- 项目深度依赖 Next.js 的"框架魔法"程度极低（见 §6），因此 vinext 迁移风险小。

## 2. Vinext 是什么

[vinext](https://github.com/cloudflare/vinext) 是 Cloudflare 的 Vite plugin，**重新实现 Next.js API surface**，而非消费 `next build` 输出。用 Vite（默认 Rolldown）替代 Next 的 bundler。

- 版本 1.3.0，peer: `vite ^8.0.0`（Vite 8 默认 Rolldown + Oxc + Lightning CSS）。
- 支持 App Router、RSC、Server Actions、route handlers、middleware、ISR、standalone output、`instrumentation.ts`。
- 官方声明："not yet a drop-in replacement for every application"，需 `vinext check` 验证。

## 3. 实测结果（隔离 worktree，2026-10-23）

### 3.1 兼容性检查

```
vinext check  →  83% compatible (15 supported, 3 partial, 2 issues)
```

- 4/4 `next/*` imports 支持（`next/server` 58 files、`next/font/google` 2 files、`next/navigation` 2 files、`next/image` 3 files）。
- 68 个 route handler 全部支持。
- `proxy.ts`（Next.js 16 middleware）支持。
- `serverExternalPackages`、`transpilePackages`、`headers`、`env`、`allowedDevOrigins` 支持。
- `tailwindcss` 兼容。

### 3.2 构建与运行

最小改动（`"type": "module"` + `vite.config.mts` + 安装依赖）后：

| 指标 | 值 |
|---|---|
| 构建时间 | **4.42s**（含 TypeScript？否，仅 Vite build） |
| 产物大小 | **19 MB**（vs Turbopack 325MB / 产物 391MB） |
| 软链数量 | **0** |
| route handlers | 68 个全部输出 |
| 启动 | `node dist/server/index.js` via `startProdServer` |

HTTP smoke test（vinext start，port 30192/30193）：

```
/                      200
/login                 307（无密码时重定向，预期）
/manifest.webmanifest  200
/api/home              200
20MB 文件上传           200
```

### 3.3 Safari 16.2 兼容

- 默认 Vite 8 baseline 比 Safari 16.2 新，**必须显式设 `build.target: "safari16.2"`**。
- 设定后 mermaid 的 `class static {}` 被降级为 0 处。
- `::highlight(pi-file-find)` CSS 伪元素在 vinext 产物中保留（Lightning CSS 不警告）。

### 3.4 Lookbehind 问题

- 原 Next 方案用 webpack/turbopack loader 重写 `mdast-util-gfm-autolink-literal` 的 lookbehind regex。
- vinext 忽略 `turbopack.rules` / `webpack()`，需改为 Vite plugin。
- 已验证：用 `createRequire` 加载原 loader，写成 Vite `transform` plugin，构建后客户端无 lookbehind 字面量。

### 3.5 Font 自托管

- `next/font/google` 1 处，vinext 构建时自托管为 26 个 woff2 文件，无运行时 CDN 依赖。

## 4. 必须处理的问题（迁移清单）

1. **`"type": "module"`**：`bin/*.js` 全是 CJS `require`，会变成 ESM。需改 `.cjs` 或改 ESM。
2. **`vinext start` 默认绑 `0.0.0.0`**：需显式 `-H 127.0.0.1` 或在启动脚本传 `host`。
3. **gfm lookbehind loader** → Vite plugin（见 §3.4）。
4. **`build.target: "safari16.2"`**（见 §3.3）。
5. **`experimental.proxyClientMaxBodySize` 被忽略**：vinext 不复刻 Next proxy body buffering。实测 20MB 上传正常，需在 100MB 上限验证。
6. **`webpack()` / `turbopack.rules` 不生效**：仅 gfm loader 受影响。
7. **`bin/rotate-preview-secrets.js`**：改 `.next` 内部 previewModeId，vinext 无对应机制。需确认新 server 的安全面或删除。
8. **`next/image` 的 `loader` 被忽略**：已 `unoptimized: true`，3 处使用，影响小。
9. **`vinext check` 报 `__dirname` 问题**：误报，`bin/` 不被打包。

## 5. 方案对比

| 方案 | 构建时间 | 产物大小 | 软链 | 代码改动 | 上游同步 |
|---|---|---|---|---|---|
| Next + webpack（现状） | 分钟级 | ~3.1G (.next) | 0 | 无 | 无成本 |
| Next + Turbopack | 14.7s | 325MB | 6 个（可脚本处理） | 无 | 无成本 |
| **vinext + Vite/Rolldown** | **4.4s** | **19MB** | **0** | `"type": "module"` + Vite config + bin 调整 + gfm plugin | API 兼容，需验证 |
| 拆 SPA + Hono | 快 | 干净 | 0 | 68 route + proxy + 测试重写 | 永久脱离上游 |

## 6. Next.js 依赖深度分析

项目对 Next "框架魔法" 的依赖极浅，这是 vinext 迁移风险低的根本原因：

- **RSC / 缓存 / 数据获取**：几乎不用。`app/page.tsx` 只做 `Suspense` 包 `AppShell`（客户端组件），无 server data fetch。所有 68 个 route handler 标 `force-dynamic`。无 `use cache`、ISR、`generateStaticParams`、`revalidate`。
- **Image 优化**：`images: { unoptimized: true }`，`next/image` 仅 2 处用于 static logo。
- **Font 优化**：`next/font/google` 仅 1 处。
- **Metadata**：`app/manifest.ts` + layout metadata export，标准 API。
- **Middleware**：`proxy.ts` 认证/限流/host 检查，标准 `NextRequest`/`NextResponse`。
- **Instrumentation**：`instrumentation.ts` Node 启动钩子，vinext 支持。

Next 在这里基本是"文件路由 + HTTP server + build 工具"，RSC/缓存/优化魔法没用到。依赖浅 → 迁移风险低。

## 7. 迁移建议

1. 开 `try/vinext` 分支，不急着合并。
2. 先做到"构建 + `bun test` + `npm test` + e2e 全绿"。
3. 补真机 Safari 16.2 验证（class static {} 降级、lookbehind fallback）。
4. 验证 100MB 上传、node-pty 终端、SSE 流、OAuth sign-in。
5. 保留 webpack 作为回退脚本（`build:webpack`），直到 vinext 稳定。
6. 上游同步成本：vinext 保留 Next API 代码，sync 时 route 文件仍可合并，但需验证 vinext 对新 API 的支持。每次 sync 后跑 `vinext check`。

## 8. 参考

- vinext 仓库：https://github.com/cloudflare/vinext
- vinext 文档：https://vinext.dev/docs
- 本地实验：隔离 worktree `/tmp/pi-web-vinext`（已清理）
- 原 Next Turbopack 构建产物：`.next-turbo/`（已清理）
- `vinext check` 完整输出见构建日志
- `lib/gfm-autolink-email-loader.cjs`：原 loader，vinext 需转为 Vite plugin