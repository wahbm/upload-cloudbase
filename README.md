# CloudBase 公共文件代理服务

这是一个 Node.js + TypeScript + Hono 服务，用服务端请求代理 CloudBase PG Storage，避免各个浏览器项目直接访问 CloudBase 时受到安全域名/CORS 限制。

CloudBase 的 `service_role` API Key 只允许放在服务端环境变量中。本服务首版只使用公开 Bucket，不提供私有文件和用户 JWT 能力。

## 快速开始

```bash
pnpm install
cp .env.example .env
# 编辑 .env，至少设置 CLOUDBASE_SERVICE_ROLE_KEY
pnpm dev
```

默认监听 `http://localhost:8787`。生产构建使用：

```bash
pnpm build
pnpm start
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLOUDBASE_ENV_ID` | `ww-d9g604vycbc0aa139` | PG CloudBase 环境 ID |
| `CLOUDBASE_SERVICE_ROLE_KEY` | 无 | 服务端专用 CloudBase API Key，不要提交到 Git |
| `CLOUDBASE_PUBLIC_BUCKET` | `public-assets` | 公开 Bucket |
| `CLOUDBASE_MAX_FILE_BYTES` | `20971520` | 单文件大小上限 |
| `PORT` | `8787` | HTTP 端口 |
| `PUBLIC_ORIGIN` | 无 | 对外服务地址，用于生成 content/download URL |
| `CORS_ORIGINS` | `*` | 逗号分隔的 Origin；首版默认允许所有来源 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 基础内存限流窗口 |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | 每 IP 每窗口请求数 |
| `MAX_LIST_LIMIT` | `100` | 单页最大文件数量 |

## API 示例

上传文件：

```bash
curl -X POST http://localhost:8787/v1/files \
  -F projectId=shop \
  -F scope=product-covers \
  -F file=@./cover.jpg
```

返回的 `data.path` 使用以下格式：

```text
projects/<projectId>/<scope>/<uuid>.<safe-extension>
```

返回的 `contentUrl` 可直接用于图片预览或视频播放，`downloadUrl` 会带下载语义：

```bash
curl -L "http://localhost:8787/v1/files/shop/product-covers/<objectName>/content" -o cover.jpg
curl -L "http://localhost:8787/v1/files/shop/product-covers/<objectName>/content?download=1" -o cover.jpg
```

列出文件：

```bash
curl 'http://localhost:8787/v1/files?projectId=shop&scope=product-covers&limit=20'
```

更新和删除：

```bash
curl -X PUT \
  -F projectId=shop \
  -F scope=product-covers \
  -F file=@./new-cover.jpg \
  'http://localhost:8787/v1/files/shop/product-covers/<objectName>'

curl -X DELETE 'http://localhost:8787/v1/files/shop/product-covers/<objectName>'
```

完整契约见 [docs/openapi.yaml](docs/openapi.yaml)，浏览器项目可以参考 [examples/storage-proxy-client.ts](examples/storage-proxy-client.ts)。

## 支持的文件类型

默认支持图片、`video/mp4`、DOCX、XLSX、字体、CSS、JavaScript、JSON、PDF 和 ZIP。服务端同时校验 MIME、大小、文件名扩展名和对象路径；文件扩展名不会直接决定允许性。

## 安全边界

本服务按当前需求使用公开文件和 `projectId` 命名空间。`projectId` 不是认证信息，任何调用者都可以尝试使用其他项目标识；知道对象路径的调用者也可能修改或删除公开对象。生产环境如果需要项目级写入隔离，应增加项目 API Key、登录 JWT、签名上传或独立 Bucket。

首版限流是单进程内存限流，多实例部署时需要替换为 Redis、网关限流或其他共享限流方案。公开上传还应考虑验证码、内容审核和更严格的 Origin 白名单。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

测试使用 mock Storage 上游，不需要真实 CloudBase 凭据。真实环境 smoke test 需要先在运行环境配置 `CLOUDBASE_SERVICE_ROLE_KEY`，不会由本项目自动修改 CloudBase Bucket 或权限策略。

## 阿里云 ECS 部署

仓库包含 GitHub Actions 部署配置：`.github/workflows/ecs-preflight.yml` 用于只读检查 ECS，`.github/workflows/deploy.yml` 用于构建并发布到 ECS。部署使用组织级 SSH 变量和密钥，不会把 CloudBase `service_role` 写入仓库或 GitHub Actions 日志。

当前部署目标使用裸 IP `8.130.116.192`，默认发布目录为 `/var/www/mosshqq/upload-cloudbase`。首次配置前先手动运行 `ECS preflight`，确认 Node.js 20、Nginx、systemd、磁盘空间、端口 80 和 passwordless sudo 状态；确认 Nginx 没有占用该 IP 后，再运行 `Deploy to Alibaba Cloud ECS` 并将 `bootstrap` 设为 `true`。后续发布可以直接推送 `main`。

首次发布会创建 `shared/app.env`，但出于安全原因不会自动生成或传输 CloudBase 密钥。请在 ECS Workbench 中将 `deploy/app.env.example` 复制为该文件，填入 `CLOUDBASE_SERVICE_ROLE_KEY`，并保持文件权限为 `0600`。服务读取的变量包括：

```bash
sudo -u deploy install -m 0600 \
  /var/www/mosshqq/upload-cloudbase/current/deploy/app.env.example \
  /var/www/mosshqq/upload-cloudbase/shared/app.env
sudo -u deploy editor /var/www/mosshqq/upload-cloudbase/shared/app.env
sudo systemctl restart cloudbase-public-file-proxy.service
```

密钥配置完成后，使用 `http://8.130.116.192/healthz` 验证服务；健康响应中的 `storageConfigured` 应为 `true`。如果 ECS 上已有其他 Nginx 站点，请先调整 `deploy/nginx/cloudbase-public-file-proxy.conf` 的路由，避免覆盖或抢占现有服务。
