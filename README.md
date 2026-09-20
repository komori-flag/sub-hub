# sub-hub

轻量级订阅管理与短链转换服务。把订阅源和「转换配置」存进 SQLite，对外只暴露一个短链
`GET /s/:key`；客户端请求短链时，服务查出该短链包含哪些订阅源，拼装请求调用后端
Subconverter 生成 Clash 配置并透传回来。

**技术栈**：Node.js 22 · TypeScript · Hono · Kysely + better-sqlite3 · Docker

---

## 目录结构

```
.
├── src/
│   ├── index.ts              # 入口：装配 app、挂路由、onError、health、优雅退出
│   ├── config.ts             # 环境变量解析与启动校验（失败即 exit 1）
│   ├── db.ts                 # Kysely 实例、建表 DDL、行↔领域对象映射、数据访问
│   ├── types.ts              # Kysely 表接口与领域类型
│   ├── middleware/auth.ts    # Bearer Token 校验
│   ├── services/
│   │   ├── converter.ts      # Subconverter URL 拼装、代理透传、缓存包装
│   │   └── cache.ts          # TTL+LRU 缓存与并发去重（single-flight）
│   └── routes/
│       ├── api.ts            # 管理接口 /api/*
│       ├── sub.ts            # 短链 /s/:key
│       └── admin.ts          # 控制台页面 /admin
├── public/admin.html         # 单页控制台（无构建步骤）
├── test/                     # 单元测试 + 端到端用的本地订阅夹具
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## 快速开始（Docker）

```bash
cp .env.example .env

# 生成一个 token 填进 .env 的 ADMIN_TOKEN=
openssl rand -hex 32

docker compose up -d --build
docker compose ps          # 两个容器都应为 Up
docker compose logs -f app # 应看到 [boot] sub-hub listening ...
```

打开 <http://localhost:3000/admin>，填入刚才的 token，即可在网页上管理订阅源与短链。

> **首次启动必须提供 `ADMIN_TOKEN`。** compose 里写的是 `${ADMIN_TOKEN:?...}`，
> 没设置会直接报错并提示；`src/config.ts` 是第二道防线（token 缺失或短于 16 字符时
> `exit 1`）。这是有意的失败关闭设计 —— 管理接口能改写订阅源，绝不能默认裸奔。

### Linux 上的目录权限

`docker-compose.yml` 按原规格使用 `./data:/app/data` 绑定挂载。容器内以 uid 1000
（`node`）运行，而绑定挂载会用**宿主机目录的属主**，所以新建的 `data/` 若属于 root，
首次写入会 `SQLITE_CANTOPEN`：

```bash
sudo chown -R 1000:1000 ./data
```

或者改用命名卷（会从镜像继承属主，开箱即用）—— 取消 `docker-compose.yml` 末尾
`subhub-data` 的注释并把挂载行换成 `subhub-data:/app/data`。
Windows / Docker Desktop 无此问题。

---

## 本地开发（不用 Docker）

**需要 Node ≥ 22。** 如果你用 nvm-windows：

```bash
nvm use 22.19.0
node -v               # 必须显示 v22.x
```

### 为什么是硬性要求，以及为什么打包救不了

`better-sqlite3@13` 需要 Node 20 不具备的 Node-API 版本。在 Node 20 上它的失败方式是
**原生 ACCESS_VIOLATION，没有任何输出** —— 不是异常，没有堆栈，连空行都没有，进程直接消失。

这一点值得说清楚，因为它推翻了一个很自然的想法：**把 TypeScript 编译成 JS 并不能解决。**

`npm run build` 产出的 `dist/` 本来就是纯 JS（零 TypeScript），但它在 Node 20 上**同样跑不起来** ——
因为 `dist/index.js` 仍然 `require` 那个原生二进制。卡住的是 `.node` 文件，不是 `.ts` 文件。
本项目的三种运行方式里没有任何一种依赖 Node 的类型擦除：

| 方式 | 用什么跑 |
|---|---|
| `npm run dev` | **tsx**（esbuild 转译，不是 Node 的类型擦除） |
| `npm test` | **tsx** + Node 22 的原生 glob |
| `npm start` / Docker | **tsc 编译产物** `dist/`，纯 JS |

所以部署路径本来就是编译后的 JS，不需要额外打包。真正需要的是 Node 22。

三道防线，遇到问题的概率依次降低：

1. `.npmrc` 的 `engine-strict=true` —— 版本不对时 `npm install` 直接失败
2. **启动时的版本检查** —— `node dist/index.js` 在 Node 20 上会明确告诉你原因，
   而不是静默崩溃（这道防线是为「已经装好了 node_modules」「拷贝来的目录」
   「预构建镜像」这些 `engines` 管不到的情况准备的）
3. `nvm use 22`

```bash
npm install
npm run dev            # tsx watch，改代码自动重启
```

需要一个可访问的 Subconverter。如果你本机已经跑着一个（默认 25500）：

```bash
ADMIN_TOKEN=devtoken-0123456789abcdef SUBCONVERTER_URL=http://localhost:25500 npm run dev
```

> 注意 `SUBCONVERTER_URL` 的取值取决于**从哪里访问**：在 compose 里是服务名
> `http://subconverter:25500`；在本机直连容器暴露的端口则是 `http://localhost:25500`。
> 写错会得到 `502 UPSTREAM_UNREACHABLE (ENOTFOUND)`，这是设计好的明确报错。

### 用 curl 走一遍

```bash
TOKEN=devtoken-0123456789abcdef
API=http://localhost:3000/api
J='Content-Type: application/json'

# 无 token -> 401
curl -s -o /dev/null -w '%{http_code}\n' $API/subscriptions

# 加订阅源
curl -s -X POST $API/subscriptions -H "$J" -H "Authorization: Bearer $TOKEN" -d @- <<'JSON'
{"id":"sub_01","name":"机场 A","url":"https://example.com/sub?token=xxx"}
JSON

# 加短链（sourceIds 可以是多个）
curl -s -X POST $API/profiles -H "$J" -H "Authorization: Bearer $TOKEN" -d @- <<'JSON'
{"key":"my-clash","target":"clash","sourceIds":["sub_01"],"udp":true}
JSON

# 取配置（公开，不需要 token）
curl -sD - -o /dev/null http://localhost:3000/s/my-clash
```

把 `http://<host>:3000/s/my-clash` 填进 Clash 客户端即可。

> **Git Bash 用户注意**：MSYS 会把看起来像 Unix 路径的参数改写掉，所以
> `curl -w '/admin -> %{http_code}\n' ...` 里的 `/admin` 会变成
> `C:/Program Files/Git/admin`，输出看起来莫名其妙。给命令加 `MSYS_NO_PATHCONV=1`
> 前缀，或者像上面那样把路径放进变量里就没事。同理，JSON 请求体请用单引号或
> heredoc（`-d @-`），不要用反斜杠转义的双引号。

---

## 管理接口

除短链外，所有 `/api/*` 都需要 `Authorization: Bearer <ADMIN_TOKEN>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/subscriptions` | 订阅源列表 |
| GET | `/api/subscriptions/:id` | 单个订阅源 |
| POST | `/api/subscriptions` | 新增/更新（upsert）。`id` 可省略，会自动生成 `sub_<16位hex>` |
| DELETE | `/api/subscriptions/:id` | 删除，成功 204 |
| GET | `/api/profiles` | 短链配置列表 |
| GET | `/api/profiles/:key` | 单个配置 |
| POST | `/api/profiles` | 新增/更新（upsert） |
| DELETE | `/api/profiles/:key` | 删除，成功 204 |

**POST 是整列覆盖**：未提供的可选项会重置为默认值（`target='clash'`、`udp=true`、
`custom_ruleset=null`、`exclude_remarks=null`），而不是保留原值。`created_at` 任何
情况下都不会被改写（类型层面 `update: never` 保证）。

请求体字段同时接受 camelCase 和数据库风格的 snake_case（`sourceIds` / `source_ids`），
响应统一用 camelCase。

**校验失败**返回 400，一次列出所有字段问题：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [
      { "field": "url", "message": "must be a valid http:// or https:// URL" }
    ]
  }
}
```

请求体不是合法 JSON 对象时返回 `INVALID_JSON`，便于和「JSON 合法但字段不对」区分。

如果 profile 里引用了不存在的订阅源 id，写入仍然成功，但响应会带 `warnings` ——
这是最常见的配置错误，提前显式提示，好过之后从 `/s/:key` 收到一个不明所以的 502。

---

## 短链 `GET /s/:key`

1. 按 `:key` 查 `profiles`，查不到 → **404**
2. 解析 `source_ids`，取其中 `enabled = 1` 的订阅源
3. 拼装 Subconverter 请求并代理
4. 透传配置内容，响应头带：
   - `Content-Type: text/plain; charset=utf-8`
   - `Profile-Update-Interval: 24`
   - `Subscription-Userinfo`（仅当上游确实返回时才有）
   - `Cache-Control: no-store`

失败时返回的是**一行 `#` 开头的 YAML 注释**，而不是 JSON —— 客户端即使把失败的响应
当成配置解析，看到的也只是注释而非语法错误。可读的机器标识在 HTTP 状态码和 code 上：

| 情况 | 状态码 | code |
|---|---|---|
| key 不存在 | 404 | `NOT_FOUND` |
| `source_ids` 是坏的 JSON | 502 | `INVALID_SOURCE_CONFIG` |
| 没有启用中的订阅源 | 502 | `NO_SOURCES` |
| Subconverter 返回非 2xx 或 HTML 错误页 | 502 | `UPSTREAM_ERROR` |
| 连不上 Subconverter | 502 | `UPSTREAM_UNREACHABLE` |
| 超时 | 504 | `UPSTREAM_TIMEOUT` |
| 返回空内容 / 超过 10 MiB | 502 | `UPSTREAM_EMPTY` / `UPSTREAM_TOO_LARGE` |
| 并发队列已满或排队超时 | 503 | `SERVER_BUSY` |
| 其它未预期错误 | 500 | `INTERNAL_ERROR`（不泄露 message 和堆栈） |

「没有启用中的订阅源」故意返回错误而不是空配置：Subconverter 对空 `url=` 会返回一个
**语法合法但内容为空**的配置并附带 200，那会静默清空用户客户端的节点列表。

---

## 缓存与并发去重

没有缓存时，每次 `/s/:key` 都会完整触发一次 Subconverter 转换，而它会去拉取**每一个**
订阅源。10 个客户端每分钟刷新 = 每分钟 10 次全量扇出，部分机场会因此限流甚至封号。

这里用两层机制解决，缺一不可：

| 机制 | 解决的问题 |
|---|---|
| **TTL 缓存**（默认 90 秒） | 正常情况下的重复请求：第二个客户端直接拿缓存，`1ms` 返回 |
| **并发去重 single-flight** | **冷启动突发**：N 个请求同时到达时，TTL 缓存**完全无效** —— 它们全都还没等到第一个完成就都已经 miss 了。single-flight 让这 N 个只产生一次扇出，其余等待同一个结果 |
| **并发上限 + 有界队列** | **不同 key 同时冷启动**：去重只能合并同一个 key，N 个不同配置会真的发起 N 次转换。这一层给 Subconverter 和机场限流兜底 |

实测（15 个请求同一瞬间打到冷 key）：

```
[sub] key=cold sources=2 upstream=200 fetch     104ms   <- 只有这一次真的调了 subconverter
[sub] key=cold sources=2 upstream=200 coalesced  92ms   <- 其余 14 个共用这一次调用
[sub] key=cold sources=2 upstream=200 coalesced  90ms
...
15 个请求全部 200，总耗时 219ms
```

### 并发上限

`MAX_CONCURRENT_CONVERSIONS`（默认 8）限制同时进行的转换数。超出的请求排队，**队列长度
和排队超时不单独暴露**，而是由它推导：队列 = 8×该值，排队超时 = `CONVERTER_TIMEOUT_MS`。
这样配置面只有一个变量，而单次请求的耗时有上界（最多等 20s + 转换 20s）。

队列满了会立刻返回 `503 SERVER_BUSY`，而不是继续排队。这一点是刻意的：无界排队在持续过载
时只是「用更慢的方式卡住」，延迟无限增长却不卸载任何压力；快速失败成一个可重试的 503，
对客户端明显更有用。

实测（`MAX_CONCURRENT_CONVERSIONS=1`，队列 8，12 个不同配置同时打进来）：

```
statuses: {"200":9,"503":3}
shed response: # SERVER_BUSY: too many conversions already queued
```

> **信号量的位置很关键。** 它放在 single-flight 闭包**内部**，所以只有领头的那个请求会去
> 抢槽位，无论后面挂了多少等待者。如果放在外面，200 个挂在上游同一调用上的等待者会各自去抢
> 一个槽位 —— 为了 1 次调用抢 200 个槽位，是彻底错的。这一点由测试钉死：`MAX_CONCURRENT_CONVERSIONS=1`
> 时 10 个同 key 并发请求必须全部成功（否则说明等待者也在抢槽位）。

### 几个设计细节

- **缓存键包含 User-Agent。** UA 是会透传给 Subconverter 的，而部分机场据它决定返回
  Clash 配置还是 base64 节点列表。只按短链 key 缓存，会让一个客户端的 UA 污染另一种
  客户端拿到的内容。
- **不需要失效逻辑。** 缓存键是「所有能影响输出的输入」的哈希，所以改了 profile 或订阅源
  就等于换了 key，下一次请求自然 miss 并重新拉取。旧 key 的条目由 TTL 自然过期。
- **缓存键是内容哈希，不是短链 key。** 由此带来一个不太直观但有用的性质：两个配置完全相同
  的短链（哪怕 key 不同）会**共用同一份缓存**。实测里 14 个配置相同的 profile 同时请求，
  只产生了 1 次 Subconverter 转换，其余 13 个是 `coalesced`。
- **只缓存成功结果。** 错误一律重试 —— 把 Subconverter 重启期间的 502 缓存下来，会把一次
  短暂抖动放大成持续一整个 TTL 的故障。
- **`?refresh=1` 强制跳过缓存。** 当你改的是**上游机场**（而不是本服务的配置）时，用它立刻
  拿新配置，不必等 TTL 过期。
- **不传递客户端断开信号。** 上游调用是多个请求共享的，如果传入某个客户端的 abort signal，
  那这个客户端一断开就会把其他人的请求一起取消。
- **缓存是进程内内存的。** 多副本部署时每个副本各有一份，退化行为是「每副本每 TTL 拉一次」，
  而不是出错。
- 缓存命中率可以从 `/health/ready` 的 `cache` 字段看到，不用靠观察 subconverter 容器忙不忙来猜。

---

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | 无（必填） | `/api/*` 的 Bearer token，至少 16 字符，未设置则拒绝启动 |
| `PORT` | `3000` | 监听端口 |
| `DATABASE_PATH` | `./data/sub.db` | SQLite 文件路径，父目录会自动创建 |
| `SUBCONVERTER_URL` | `http://subconverter:25500` | 后端地址，末尾斜杠会被去掉 |
| `CONVERTER_TIMEOUT_MS` | `20000` | 单次转换总超时（含拉取所有源），范围 1000–120000 |
| `CACHE_TTL_MS` | `90000` | 生成结果的复用时长，`0` 表示完全关闭缓存，范围 0–3600000 |
| `CACHE_MAX_BYTES` | `67108864` | 缓存正文的内存上限（64 MiB），超出按 LRU 淘汰，范围 1 MiB–1 GiB |
| `MAX_CONCURRENT_CONVERSIONS` | `8` | 同时进行的转换数上限，范围 1–64。队列长度为其 8 倍，排队超时用 `CONVERTER_TIMEOUT_MS` |

---

## 部署到公网

### 推荐拓扑：都放同一台 VPS

```
Clash 客户端 ──HTTPS──> Cloudflare 边缘 ──隧道──> VPS: sub-hub ──compose 内网──> subconverter
```

`sub-hub` 和 `subconverter` 放在同一台机器上，用现有的 `docker-compose.yml` 原样跑，
`cloudflared` 走**出站**连接把 app 发布出去。VPS 上不需要开放任何入站端口，也不需要
反向代理或自签证书。

**VPS 上不需要装 Node。** 构建全部发生在容器里，所以只要 Docker。

#### 1. 装 Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

重新登录一次让组权限生效（否则每条 docker 命令都要 `sudo`）。

#### 2. 把代码传上去

这个项目目前**不是 git 仓库**，所以 VPS 上没法 `git clone`。压缩后只有 55K ——
`node_modules/` 会在容器里重建，`dist/`、`data/`、`.env` 是本地状态，都不该传。

在本机（Git Bash）执行：

```bash
cd /c/ScriptTestFile/sub-hub
tar czf /tmp/sub-hub.tgz \
  --exclude=node_modules --exclude=dist --exclude=data --exclude=.env .
scp /tmp/sub-hub.tgz your-user@your-vps:~/
```

在 VPS 上解包：

```bash
mkdir -p ~/sub-hub && tar xzf ~/sub-hub.tgz -C ~/sub-hub && cd ~/sub-hub
```

> 想省掉以后每次手工传，可以 `git init` 后推到一个**私有**仓库再从 VPS clone。
> `.gitignore` 已经排除了 `node_modules/`、`dist/`、`data/`、`.env`。

#### 3. 修 `data/` 权限 —— 这一步漏掉必挂

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

容器内以 uid 1000（`node`）运行，而绑定挂载用的是**宿主机目录的属主**。漏掉这步会在
首次写入时报 `SQLITE_CANTOPEN` —— 那个报错看起来像数据库损坏，实际是权限问题，
很容易查错方向。

也可以用命名卷彻底绕开：把 `docker-compose.yml` 里的挂载改成 `subhub-data:/app/data`
并取消末尾 `volumes:` 的注释。命名卷会从镜像继承属主，不需要 chown。

#### 4. 配置

```bash
cp .env.example .env
openssl rand -hex 32      # 填进 .env 的 ADMIN_TOKEN=
```

想开 subconverter 的 token 验证就再填 `SUBCONVERTER_TOKEN`（见“proxy 的隔离与 token 验证”）。

#### 5. 建 Cloudflare Tunnel

面板里 Zero Trust → Networks → Tunnels → Create a tunnel，然后在 Public hostname 填：

```
sub.example.com   ->   http://app:3000
```

**注意填的是服务名 `app:3000`，不是端口映射** —— cloudflared 和 app 在同一个 compose
网络里，用服务名解析。把面板给的 token 填进 `.env` 的 `TUNNEL_TOKEN=`。

#### 6. 起服务

```bash
docker compose --profile tunnel up -d --build
docker compose ps          # 两个容器都应为 Up
docker compose logs -f app
```

#### 7. 验证

```bash
curl -s https://sub.example.com/health          # {"status":"ok",...}
curl -s https://sub.example.com/health/ready    # db 与 cache 状态
curl -s -o /dev/null -w '%{http_code}\n' \
     https://sub.example.com/admin              # 200（页面本身公开）
curl -s -o /dev/null -w '%{http_code}\n' \
     https://sub.example.com/api/subscriptions  # 401（无 token）
```

四条都对就说明鉴权、数据库、隧道都通了。最后把
`https://sub.example.com/s/<你的key>` 填进 Clash 即可。

### 常见故障对照

| 现象 | 原因 |
|---|---|
| `SQLITE_CANTOPEN` / `unable to open database file` | 第 3 步没做，`data/` 属主不对 |
| `502 UPSTREAM_UNREACHABLE (ENOTFOUND)` | `SUBCONVERTER_URL` 写成了 `localhost` 或公网地址 —— compose 内网要用服务名 `subconverter` |
| 隧道通了但 502 | cloudflared 的 Public hostname 填成了 `localhost:3000` 而不是 `app:3000` |
| `[fatal] refusing to start` | `.env` 里 `ADMIN_TOKEN` 没填或短于 16 字符（这是故意的，见启动日志） |
| 构建时被 OOM kill | 小内存 VPS（512M）编译吃紧。在本机 `docker build` 后 `docker save` 传镜像，或在 VPS 上加 swap |

> **建议顺手做的两件事**
>
> 1. **把 `app` 的端口映射改成 `127.0.0.1:3000:3000`。** 隧道走的是 compose 内网，
>    公网部署时 `3000:3000` 没有必要，绑回环既保留本机调试能力又不对外。
>    记得同时把 `ADMIN_TOKEN` 换成上面新生成的随机值 —— 别用开发时那个。
> 2. **给 `/admin` 和 `/api/*` 加 Cloudflare Access。** 这比我写的 Bearer token 强得多：
>    token 是静态共享密钥，而 Access 能接身份提供商做真实登录。在 Zero Trust ->
>    Access -> Applications 里新建应用，路径填 `sub.example.com/admin` 和
>    `sub.example.com/api`，策略设成只允许你自己。
>    **不要给 `/s/*` 加 Access** —— Clash 客户端没法走浏览器登录流程。

### 不建议的拓扑：sub-hub 本地 + subconverter 放 VPS

这样能跑，但有两个实际代价：

1. **subconverter 必须公网暴露。** 它的 `/sub?url=` 接受任意 URL 并由服务端去 fetch ——
   本质上是个 SSRF 原语。放公网上会被扫到并滥用，你的 VPS 会变成别人的免费代理。
   真要这么做，至少加一层共享密钥，并限制只允许你的 sub-hub 出口 IP 访问。
2. **每次缓存未命中都多一次跨公网往返**，而 Worker/VPS 的地理位置和你的距离直接影响延迟。

既然 VPS 已经要开了，把 sub-hub 一起放上去成本几乎为零（它只是个几十 MB 的容器），
却能同时消掉这两个问题。

### proxy 的隔离与 token 验证

「让 subconverter 只监听 127.0.0.1」这个想法在容器拓扑下**会直接把它变成不可达**，值得说清楚：

> Docker 容器里的 `127.0.0.1` 是**容器自己的回环**，不是宿主机的，也不是其他容器的。
> 如果 subconverter 在自己的容器内绑 `127.0.0.1`，那么同在 compose 网络里的 sub-hub
> 根本连不上它 —— 只会得到 `ECONNREFUSED`。

正确做法就是现在 compose 里的样子：subconverter 在**容器内**监听 `0.0.0.0`，但**不发布
任何端口**。从宿主机和公网都够不到它，只有 compose 网络内的服务能访问。这比绑
`127.0.0.1` 更强 —— 绑回环只防住宿主机外部，而「不发布端口」是彻底不暴露。

**关键区别：bind 地址控制「谁能从外面连进来」，token 控制「网络内哪个容器能用它」。**
因为 compose 网络里任何容器都能访问任何其他容器，所以「只有 sub-hub 能用」这件事
**只能靠 token 表达，绑地址表达不了**。

所以 token 值得开，尤其是 VPS 上还跑着别的东西的时候。开启方式是一个变量：

```bash
# .env
SUBCONVERTER_TOKEN=$(openssl rand -hex 24)
```

compose 会把它**同时**送给两端 —— sub-hub 开始发送它，subconverter 开始要求它。
`API_MODE` 是从 token 派生的（`${SUBCONVERTER_TOKEN:+true}`），所以不存在
「设了 token 却忘了开验证」这种静默失效。留空则该功能完全关闭。

开启后验证它真的生效：

```bash
docker compose exec subconverter \
  wget -qO- 'http://127.0.0.1:25500/sub?target=clash&url=https://example.com' | head -3
```

应当被拒绝或报错。**如果它返回了配置，说明验证没生效。**

> 已知的验证行为，开启前请确认：Subconverter 的 `api_mode` 官方描述是「阻止直接加载
> 本地订阅或提供本地文件，访问这类内容需要附带 `&token=`」。对于本服务用的
> **远程 `url=` 订阅**是否也强制要 token，不同版本行为可能有差异 —— 上面的命令就是
> 用来确认这一点的。无论是否强制，sub-hub 都会在设置了 token 时带上它。

### 客户端配置

部署完成后，短链就是：

```
https://sub.example.com/s/my-clash
```

填进 Clash 当作订阅地址即可。响应头的 `Profile-Update-Interval: 24` 会让客户端按每 24
小时更新，但服务端缓存是 90 秒 —— 也就是说机场更新节点后，客户端下次刷新就能拿到新的，
不受 24 小时影响（那只是客户端的轮询间隔提示）。

---

## 两个容易踩的坑

### 1. 多订阅源的分隔符为什么是 `%7C` 而不是 `|`

原规格写的是「encode 后用 `|` 连接」，但 Subconverter 官方要求的是**先用 `|` 连接、
再对整串 encode**，管道符会变成 `%7C`。本实现用的是 `%7C`。

之所以两者在 Subconverter 那边等价，是因为上游的处理顺序：

1. cpp-httplib 在 Subconverter 看到之前就**先对每个 query 参数做了百分号解码**
   （`include/httplib.h:4188`）
2. Subconverter 原样接过这些已解码的参数（`src/server/webserver_httplib.cpp:52`）
3. 再按 `|` 切分（`src/handler/interfaces.cpp:152`）

先解码后切分 ⇒ 在切分点 `%7C` 和裸 `|` 完全一样。选择 `%7C` 纯粹是传输层的考虑：
裸 `|` 不是合法 URI 字符，部分代理、WAF 和严格的 HTTP 解析器会直接 400 —— 而这类
失败**只在经过反代的部署里出现**，恰恰是本地最难复现的。

如果你换了后端、确认要用裸 `|`，改
[`src/services/converter.ts`](src/services/converter.ts) 里的 `SOURCE_SEPARATOR` 一个常量即可。

顺带两个由此而来的硬约束（已由测试钉住）：

- **绝不能用 `URLSearchParams` 拼这个 query。** 它把输入当成已解码的字符串再编码一次，
  `https%3A%2F%2F...` 会变成 `https%253A%252F%252F...`，Subconverter 解码一次后拿到
  字面量字符串 `https%3A%2F%2F...`，然后尝试去 fetch 这个「URL」并失败。症状是
  **HTTP 200 + 空配置**，看起来像 Subconverter 的 bug。
- **必须用 `encodeURIComponent`，不能用 `encodeURI`。** cpp-httplib 会把 query 值里的
  `+` 解成空格，所以 token 里带 `+` 的订阅地址会被静默改坏；`encodeURI` 还不会转义
  `&` 和 `#`，那会直接把 `url` 参数截断。

### 2. `Subscription-Userinfo` 不出现是正常的

只有**上游订阅源自己上报了流量信息**时 Subconverter 才会带这个头。纯节点列表、裸
Clash YAML、base64 订阅都没有流量元数据，所以头就是不存在 —— 不是 bug。如果配了多个
源，Subconverter 会把**上报了的那些**相加，不代表你的实际套餐总量。

---

## 安全须知

- **短链是无鉴权的 capability URL。** 拿到 key 的人就能得到包含你全部节点凭据的配置，
  且可以无限次拉取。「`my-clash`」这种好记的 key 适合内网测试；对公网暴露时请用 20 位
  以上的随机 key，并在前面加一层反代做 TLS 和限流。key 会出现在容器日志里，当作密码对待。
- **token 走明文 HTTP 是能被嗅探的。** compose 把 3000 发布在 `0.0.0.0`。局域网里这已
  经是风险，公网则不可接受 —— 请在反代上终止 TLS。
- **Subconverter 的端口故意没有发布。** 它的 `/sub?url=` 接受任意 URL 并由服务端去
  fetch，本质上就是一个 SSRF 原语；发布 25500 等于把「代理任意外站请求」的能力交给整个
  局域网。app 通过 compose 网络用服务名访问它。调试时请用绑定回环的
  `127.0.0.1:25500:25500`。
- **`source.url` 是间接的 SSRF 入口。** 写接口只校验了 http/https 协议，挡不住指向内网
  地址（`169.254.169.254` 之类）的 URL。真正的缓解是结构性的：别把 token 给不该给的人。
- **控制台页面本身是公开的**，这是有意的 —— 它就是登录页，不含任何数据，所有真实操作都
  在需要 token 的 `/api/*` 后面。token 存在 `localStorage` 并以显式请求头发送，所以
  **不存在 CSRF 面**（浏览器不会自动附带这个头）；代价是对 XSS 敏感，而页面全程只用
  `textContent` 渲染用户数据，从结构上避免了这一点。

---

## 端到端自测

`test/fixtures/` 里有两个只含测试节点的 Clash 配置和一个静态服务器，可以在不依赖任何
第三方订阅的情况下验证完整的合并链路：

```bash
# 终端 1：起夹具服务
node test/fixtures/serve.cjs 8801

# 终端 2：起 app，指向一个真实的 subconverter
ADMIN_TOKEN=devtoken-0123456789abcdef SUBCONVERTER_URL=http://localhost:25500 npm run dev

# 终端 3：建两个源 + 一个双源短链
TOKEN=devtoken-0123456789abcdef; API=http://localhost:3000/api; J='Content-Type: application/json'
curl -s -X POST $API/subscriptions -H "$J" -H "Authorization: Bearer $TOKEN" \
  -d '{"id":"sub_01","name":"A","url":"http://127.0.0.1:8801/sub1.yml"}'
curl -s -X POST $API/subscriptions -H "$J" -H "Authorization: Bearer $TOKEN" \
  -d '{"id":"sub_02","name":"B","url":"http://127.0.0.1:8801/sub2.yml"}'
curl -s -X POST $API/profiles -H "$J" -H "Authorization: Bearer $TOKEN" \
  -d '{"key":"my-clash","target":"clash","sourceIds":["sub_01","sub_02"],"udp":true}'

# 断言：两个源的节点都在，说明 %7C 拼接被 Subconverter 正确切分了
curl -s http://localhost:3000/s/my-clash | grep -c TEST-A1   # -> 2 或更多
curl -s http://localhost:3000/s/my-clash | grep -c TEST-B1   # -> 1 或更多
```

输出里 `TEST-A*` 和 `TEST-B*` 同时出现才算通过 —— 这正是分隔符编码是否正确的判据。

单元测试（纯函数，不需要起服务）：

```bash
npm test          # 断言 %7C 拼接、不双重编码、+ 转义、坏 JSON 容错
npm run typecheck
```

---

## 已知取舍

- **缓存的 TTL 是权衡，不是纯收益。** 90 秒意味着机场更新节点后，客户端最多要等 90 秒
  才看到新节点。想更快就把 `CACHE_TTL_MS` 调小；想更省就调大。
- **仍然不能靠 HTTP 缓存。** 响应上的 `Cache-Control: no-store` 是刻意的：Subconverter
  生成的配置依赖服务端状态，让中间的缓存层或客户端自己缓存，会导致改了 profile 之后长时间
  拿到旧配置。缓存必须由服务端按缓存键管理，这也是它做在这里的原因。
- **限流是针对「不同的转换」，不是「不同的请求」。** 200 个请求打到同一个冷 key 只会占用
  1 个并发槽位（其余是 single-flight 等待者，不抢槽位），所以那种情况下不会触发 `SERVER_BUSY`。
  会被限的是 200 个**不同配置**同时冷启动 —— 那确实需要 200 次转换，此时超出队列的请求
  会拿到 503。
- **`SERVER_BUSY` 是客户端该重试的信号。** 它不写进缓存，队列一空下次请求就能正常通过。
  Clash 客户端通常会自行重试订阅更新。
- **`CREATE TABLE IF NOT EXISTS` 不会升级已有表。** 现在够用；等 schema 要改的时候，在
  `src/db.ts` 里加一段 `PRAGMA user_version` 判断并跑编号的 `ALTER`，别指望重新部署会
  自动迁移。
- **`better-sqlite3` 是同步的，会阻塞事件循环。** 这里每个查询都是几行表的索引主键查询，
  规模上无所谓；但要知道这是它的硬上限。
- **删除订阅源不会清理 profile 里的 `source_ids`。** schema 里存的是 JSON 数组，没有外键
  可级联。解析时会跳过不存在的 id，所以行为是安全的，只是表现为「配置静默变小」而不是
  报错 —— profile 写入时的 `warnings` 就是针对这一点的缓解。
- **`tindy2013/subconverter:latest` 是可变标签。** 正式用之前请固定到 digest，它的 target
  列表和参数处理在版本间变过。
