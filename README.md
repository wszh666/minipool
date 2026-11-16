# 🎱 极简台球 Minipool

中式八球（Chinese 8-ball）网页台球游戏。**单个 HTML 文件就能玩**，想两人对战时再启动一个**零依赖**的 Node 服务器（WebSocket 是自己手写的，不需要 npm install 任何包）。

> 手机、平板、电脑都能玩，横屏体验更好。

---

## 三种玩法

| 玩法 | 怎么开 | 需要什么 |
| --- | --- | --- |
| **单机** | 直接双击 `pool.html`（或用浏览器打开） | 什么都不需要，断网也能玩 |
| **局域网对战** | `node pool-server.js`，两人打开同一个 `http://192.168.x.x:8080` | 装了 Node，同一个 WiFi |
| **异地联机** | 见下面「异地联机」 | 一个公网地址（Render 免费部署 / 云服务器 / 内网穿透都行） |

---

## 快速开始

### 1. 单机玩

下载仓库后双击 `pool.html` 即可。或者直接在线玩：
<https://wszh666.github.io/minipool/pool.html>

> 在线托管版（GitHub Pages）只有静态页面，**只能单机玩**。要联机得先部署服务器（见下节），
> 再把服务器地址填进游戏右上角「联机」弹窗的「服务器」输入框，格式 `wss://你的域名/ws`。

### 2. 局域网对战

```bash
node pool-server.js
```

启动后终端会打印：

```
🎱 台球服务器已启动
   本机：  http://localhost:8080
   局域网：http://<你的局域网IP>:8080
```

两个人用浏览器打开同一个地址（同 WiFi 用局域网地址），一方点右上角「联机」→「创建房间」拿到 4 位房号，另一方输入房号「加入」。两边到齐会自动掷骰子决定谁开球。

### 3. 异地联机（给朋友玩）

服务器必须能被公网访问。三种办法，从省事到麻烦：

**A. 一键部署到 Render（推荐，免费）**

1. 点这里 → [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)
2. 选中本仓库，Render 会读 `render.yaml` 自动配好（`node pool-server.js`，`POOL_IDLE_MINUTES=0`）
3. 部署完拿到 `https://minipool-xxxx.onrender.com`，把这个链接发给朋友，两边打开就能联机

> 免费实例 15 分钟无人访问会休眠，醒来要等约 30 秒；介意的话用 B。

**B. 自己的云服务器**

```bash
git clone https://github.com/wszh666/minipool.git
cd minipool
node pool-server.js          # 或 pm2 start pool-server.js --name pool
```
放行 8080 端口（或反代到 443）。

**C. 内网穿透（在自己电脑上开）**

```bash
node pool-server.js
cloudflared tunnel --url http://localhost:8080 --protocol http2
# 输出里会给你一个 https://xxx.trycloudflare.com，发给朋友即可
```

Windows 用户可以直接双击 `启动联机.bat`：它会自动起服务器 + Cloudflare 隧道，把公网地址复制到剪贴板并打开浏览器。（`tools/cloudflared.exe` 体积 55MB 未入库，请自行从 Cloudflare 官方下载放到 `tools/` 下。）
注意：免费隧道地址**每次重启都会变**。

---

## 操作说明

**电脑**
- 移动鼠标：瞄准（角度做了平滑）；虚线是方向，透明圈是白球撞击点
- 按住左键：蓄力（约 1.5 秒蓄满）；蓄力中按右键：锁定力度；松开左键出杆
- 鼠标侧键 / `Esc`：取消蓄力
- 「跳球」按钮：点一下开启，下一杆白球会腾空跃过挡路的球
- 左上角小白球控件：拖动红点设置跟杆 / 拉杆 / 左右塞；双击复位中杆
- `3`：重新摆球（自由球放好后想再挪位置）

**手机（底部三个按钮，从左到右）**
- 手指在台面拖动 = 瞄准
- 左下「锁定力度」：按住右下按钮蓄力时点一下，力度停住不再涨
- 中下「重新摆球」：白球落袋或对手犯规拿到自由球、放好之后想再挪动时点它
- 右下「按住击球」：按住蓄力，松手出杆
- 建议横屏，横屏时球桌会自动缩到按钮栏上面

---

## 规则（中式八球）

- 16 颗球：白球 + 1~7 全色 + 8 号黑球 + 9~15 花色
- 开球：白球放在开球线后；必须有球进袋或至少 2 颗目标球碰库，否则犯规（开球进 8 号把 8 号摆回，不算输）
- 定花色：开球后局面「开放」，谁先合法进球谁定花色
- 合法击球：白球必须先碰到自己那组球；开放局面时不能先碰 8 号
- 一杆内进球顺序：第一颗进袋的必须是自己的球，否则犯规；先自己的球、后带进对方的球不算犯规
- 犯规（空杆 / 先碰对方球 / 先碰 8 号 / 白球落袋 / 第一颗进的是对方的球）→ 对手获得自由球，可把白球放在台面任意合法位置
- 进球可以继续打；没进球就换人
- 8 号球必须最后打：清完自己那组后合法打进 8 号获胜；提前打进 8 号、或进 8 号同时犯规判负
- 抢黑八阶段（台面只剩 8 号）白球落袋直接判负

---

## 技术说明

### 架构

```
浏览器 A ──WebSocket──┐
                      ├─ pool-server.js（http + 手写 WS，端口 8080）
浏览器 B ──WebSocket──┘        └─ 顺带把 pool.html 作为静态页发出去
```

- **服务端**：只用 Node 内置 `http` / `fs` / `crypto` / `child_process`，没有第三方依赖。WebSocket 握手用 `Sec-WebSocket-Key` + 固定 GUID 做 SHA1+base64，帧编解码（掩码、126/127 扩展长度、ping/pong、close）全部手写。
- **房间**：`Map`，房号 4 位数字（1000–9999，冲突重试）。双方到齐服务端掷骰子定先手（奇数玩家1、偶数玩家2）。
- **同步模型**：**房主（seat 0）权威**。任何规则变化（进球、换人、犯规、重开）后房主发全量快照 `sync`；对手收到 `shot` 后本地照常物理演算但不判罚，等快照覆盖结果。瞄准线单独走 `aim`（90ms 节流 + 变化阈值）。
- **无状态**：房间只存在内存里，双方都离开即销毁；不落库、不需要账号。

### 消息协议

| 方向 | `t` | 内容 |
| --- | --- | --- |
| C→S | `create` | 建房，可带初始 `state` |
| C→S | `join` | `code` 加入 |
| C→S | `sync` | 全量快照 `state` |
| C→S | `shot` | 一杆 `{aim, strike, power}` |
| C→S | `aim` | 实时瞄准 `{aim, strike}` |
| C→S | `leave` | 离开房间 |
| S→C | `created` / `joined` | 房号 + 座位 |
| S→C | `peer` | 对手 `joined` / `left` |
| S→C | `dice` | 骰子点数 |
| S→C | `sync` / `shot` / `aim` | 转发对手的动作 |
| S→C | `error` / `left` | 错误提示、离开确认 |

### 其他

- 页面每 60 秒 `POST /__ping`；连续 `POOL_IDLE_MINUTES`（默认 20）没人用就自动退出，顺带关掉自己启的那条 cloudflared（读 `tunnel.pid` 并校验进程名，防 PID 复用误杀）。云端部署设 `POOL_IDLE_MINUTES=0` 关闭。
- `GET /__status` 返回 `{ok, port, clients, rooms, idleSeconds}`，方便探活。
- 本地文件（`file://`）打开时前端回退到 `ws://localhost:8080/ws`；用网址打开时按页面协议自动选 `ws://` / `wss://`（HTTPS 页面必须 wss）。

---

## 目录结构

```
pool.html          游戏本体（单文件，双击即玩）
pool-server.js     联机服务器（零依赖）
index.html         在线版落地页（GitHub Pages 首页）
启动联机.bat        Windows 一键联机（服务 + Cloudflare 隧道）
start-online.ps1   上面那个 bat 实际调用的脚本
使用说明.txt        给玩家的中文说明书（更口语版）
render.yaml        Render 一键部署配置
tests/e2e-online.mjs  联机端到端冒烟测试
```

## 测试

```bash
npm test        # 或 node tests/e2e-online.mjs
```

会临时起一个服务器（端口 8099），模拟两个浏览器走完整流程：建房 → 加入 → 掷骰子 → 快照同步 → 一杆转发 → 瞄准线 → 重复房号/满员拒绝 → 离开后房间销毁。需要 Node 21+（内置 WebSocket）。

## 想把这套联机搬到你自己的游戏？

这个仓库的**联机部分和台球本身几乎无关**，可以直接剥出来复用。分层很清楚：

| 你要的东西 | 在哪个文件 | 大概位置 |
| --- | --- | --- |
| HTTP 服务 + 静态页托管 + `/__ping` `/__status` | `pool-server.js` | 第 51–89 行 |
| **WebSocket 握手**（`Sec-WebSocket-Key` → SHA1 → base64，回 101） | `pool-server.js` | 第 94–106 行 |
| **帧编解码**（掩码、126/127 扩展长度、ping/pong、close） | `pool-server.js` | 第 109–157 行（`encode` / `decode`） |
| 连接对象（收帧、发 JSON、断开清理） | `pool-server.js` | 第 164–224 行（`class Client`） |
| 房间表 + 房号生成 | `pool-server.js` | 第 160、226–232 行 |
| **消息路由**（建房/加入/同步/转发/离开） | `pool-server.js` | 第 234–309 行（`handle`） |
| 空闲自动退出 | `pool-server.js` | 第 18–48、311–322 行 |
| 前端连接管理（自动选 ws/wss、重连提示、发送） | `pool.html` | 搜索 `netConnect` / `netSend` / `defaultServer` |
| 前端状态快照序列化 | `pool.html` | 搜索 `function snapshot` |
| 前端收到远端点后的处理 | `pool.html` | 搜索 `onNet` / `applySnapshot` / `applyRemoteShot` |

### 复用顺序（推荐）

1. **先只搬服务端**（`pool-server.js` 去掉读 `pool.html` 的那段即可），确认 `node server.js` 能起、能握手。
2. **再定义你自己的消息协议**。台球用的是最小集：`create` / `join` / `sync`（全量快照）/ `shot` / `aim` / `leave`，服务端推 `created` / `joined` / `peer` / `dice` / `sync` / `shot` / `aim` / `error` / `left`。你的游戏换个字段名就行，**路由逻辑不用动**。
3. **最后接前端**：连上 → 建房/加入 → 拿到座位号（seat）→ 用 `seat === 谁的回合` 做输入守卫 → 每次状态变化发全量快照。

### 关键设计（别丢这三个）

- **权威端只有一方**：房主（seat 0）算结果、发全量快照；对手收到动作先本地演算但**不判罚**，等快照覆盖。这是最简单也不容易 diverg（两边状态跑偏）的做法。状态量小就直接全量快照，别一上来搞增量同步。
- **快照必须带版本相关的全部真值**：台球的快照里连球的**号码**都带（因为开球摆位时号码会变），否则两边球号会对不上。
- **输入守卫在前端**：`canOperate() { return !NET.online || NET.seat === GAME.turn; }` 一行就够，别指望服务端拦（服务端只是转发）。

### 移植时要自己补的（本项目没做）

- **重连**：现在断线就是断线，没有会话恢复（房间只在内存里，断开即清理）。
- **超过 2 人**：房间结构是 `{a, b}` 两个座位，要多人得改成数组 + 广播。
- **鉴权**：房号 4 位、可被猜，公网长期开着会有陌生人扫房号。真要长期公网跑，加个密码或 token。
- **状态持久化**：全在内存，进程一挂全没。
- **反作弊**：服务端只转发不校验，客户端能伪造任何动作。朋友之间玩没问题，公开对战要服务端裁决。

### 不同技术栈怎么办

- **浏览器 JS 游戏**（Canvas / Phaser / Cocos Creator / 微信小游戏）：整套直接抄，前端用浏览器原生 `WebSocket`，零依赖。
- **Unity / Godot**：服务端照搬（Node 跑），客户端换成引擎自己的 WebSocket API（Unity 用 `ClientWebSocket`，Godot 用 `WebSocketPeer`），协议 JSON 完全一样。
- **Python / 其他后端**：帧编解码那 50 行是标准 RFC 6455，可以换成现成库（Python `websockets`、Go `gorilla/websocket`），房间与消息路由的分层照抄思路即可。

## License

MIT
