# ironclaw-weixin-bridge

`ironclaw-weixin-bridge` 是一个给 `IronClaw` 用的独立微信桥接器。

它的目标很直接：

- 不依赖 `openclaw`
- 不改 `IronClaw` 源码
- 通过扫码登录把微信消息桥接到 `IronClaw gateway`

如果你本机已经装好并跑着 `IronClaw`，最短路径就是这 2 步：

```bash
npx ironclaw-weixin-bridge login --account default
npx ironclaw-weixin-bridge run
```

这版会优先自动发现本机 `IronClaw` 的：

- gateway token
- gateway host
- gateway port

自动发现走的是 `ironclaw config get ...`，所以只要本机 `ironclaw` 已经正常初始化，用户通常不需要再手填 `gatewayToken`。

它不依赖：

- `openclaw`
- `openclaw plugins install`
- `OpenClaw` 插件 SDK

它的工作方式很直接：

1. 通过腾讯上游微信 bot 服务扫码登录。
2. 使用 `ilink/bot/getupdates` 长轮询收消息。
3. 把每个 `账号 + 对端用户` 映射成独立的 `IronClaw thread`。
4. 通过 `IronClaw` 的 gateway API 把消息送进去。
5. 通过 `IronClaw` 的 SSE 事件流拿到回复，再回发到微信。

## 功能现状

当前已经支持：

- 微信扫码登录
- 微信长轮询收消息
- 每个微信用户独立 thread，避免上下文串话
- 文本消息转发到 `IronClaw`
- 文本回复回发微信
- 微信入站图片下载后作为 `IronClaw` 图片输入发送
- 微信入站文件、视频、语音保存到本地，并把路径提示传给 `IronClaw`
- `IronClaw` 的 `image_generated` 事件自动回发微信图片
- 从 `IronClaw` 回复里提取 markdown 图片 URL
- 从 `IronClaw` 回复里提取本地文件路径并尝试作为微信媒体发送
- `get_updates_buf`、账号信息、会话映射的本地持久化

当前还没有做的部分：

- 原生 `IronClaw` WASM channel 打包
- 微信群聊路由
- typing 指示器
- 对原始语音的本地转写
- 对文档内容做高级抽取后再送入 `IronClaw`

所以它现在更准确的定位是：

一个可部署、可测试、可开源的 `IronClaw + 微信桥接层`，而不是 `IronClaw` 官方内建 channel。

## 运行要求

- Node.js 22+
- 一个已经能正常运行的 `IronClaw` gateway
- `IronClaw` 已启用 gateway
- 本机可执行 `ironclaw`

## 配置文件

示例配置见：

[/root/ironclaw-weixin-bridge/config.example.json](/root/ironclaw-weixin-bridge/config.example.json)

你可以复制为自己的 `config.json`，核心字段如下：

```json
{
  "stateDir": "./state",
  "ironclaw": {
    "baseUrl": "http://127.0.0.1:3000",
    "gatewayToken": "replace-with-your-gateway-token",
    "responseTimeoutMs": 300000,
    "reconnectDelayMs": 1500
  },
  "weixin": {
    "baseUrl": "https://ilinkai.weixin.qq.com",
    "loginBotType": "3",
    "longPollTimeoutMs": 35000,
    "idleRetryDelayMs": 2000
  },
  "bridge": {
    "sendTyping": false,
    "unsupportedMediaNotice": true
  },
  "accounts": [
    {
      "id": "default",
      "enabled": true,
      "name": "default",
      "allowFrom": []
    }
  ]
}
```

建议：

- 仓库里的 `config.json` 只保留安全占位值，不要直接提交真实 token
- 你自己的联调配置优先放到 `config.local.json` 或其他未纳入版本控制的文件里
- `state/` 目录里会保存微信登录态和会话映射，不要提交
- 如果不传 `--config`，程序会先走内置默认值，并自动尝试从本机 `ironclaw config` 读取 gateway 设置

### 环境变量覆盖

支持这些环境变量覆盖配置：

- `BRIDGE_STATE_DIR`
- `IRONCLAW_BASE_URL`
- `IRONCLAW_GATEWAY_TOKEN`
- `WEIXIN_BASE_URL`
- `WEIXIN_LOGIN_BOT_TYPE`

## 使用方式

推荐直接通过 `npx` 使用，不需要全局安装：

```bash
npx ironclaw-weixin-bridge help
```

说明：

- 我已经检查过 npm registry，`ironclaw-weixin-bridge` 这个名字当前没有被占用
- 如果你后续决定改名，再同步修改 [package.json](/root/ironclaw-weixin-bridge/package.json) 的 `name` 即可

如果你是从源码仓库运行，也可以继续使用：

```bash
npm install
```

然后执行本地命令：

```bash
node ./src/cli.mjs help
```

## 配置准备

如果你需要覆盖默认值，或者本机无法自动发现 `IronClaw` 配置，再准备一份本地配置：

```bash
cp ./config.example.json ./config.local.json
```

然后按需覆盖这些字段：

- `ironclaw.baseUrl`
- `ironclaw.gatewayToken`
- `weixin.baseUrl`

填进去。

这个项目没有额外的运行时依赖，主要是为了统一本地项目管理和测试入口。

## 登录

先执行扫码登录：

```bash
npx ironclaw-weixin-bridge login --account default
```

执行后程序会输出二维码 URL。你可以：

- 直接打开这个 URL
- 或者自己包一层，把它渲染成二维码图片

登录成功后，账号信息会保存到：

```text
<stateDir>/accounts/default.json
```

如果你需要显式指定配置文件：

```bash
npx ironclaw-weixin-bridge login --config ./config.local.json --account default
```

如果你是从源码仓库直接运行，对应命令是：

```bash
node ./src/cli.mjs login --account default
```

## 运行桥接器

```bash
npx ironclaw-weixin-bridge run
```

启动后会自动：

- 读取已保存的微信账号 token
- 恢复上次的 `get_updates_buf`
- 恢复微信用户到 `IronClaw thread` 的映射
- 持续轮询微信消息
- 持续监听 `IronClaw` SSE 事件
- 把最终回复回发给微信

如果你需要显式指定配置文件：

```bash
npx ironclaw-weixin-bridge run --config ./config.local.json
```

如果你是从源码仓库直接运行，对应命令是：

```bash
node ./src/cli.mjs run
```

## 健康检查

```bash
npx ironclaw-weixin-bridge doctor
```

会检查：

- `IronClaw` gateway 是否可连通
- gateway token 是否有效
- 本地账号是否已经登录

如果你需要显式指定配置文件：

```bash
npx ironclaw-weixin-bridge doctor --config ./config.local.json
```

如果你是从源码仓库直接运行，对应命令是：

```bash
node ./src/cli.mjs doctor
```

## 测试

运行全部测试：

```bash
npm test
```

当前自动化测试覆盖：

- 配置加载与环境变量覆盖
- 状态持久化
- SSE 解析
- `IronClaw` 响应聚合
- 图片/数据 URL/AES 媒体工具函数
- markdown/media 解析
- 桥接主流程中的文本与媒体回发

## 项目结构

- `src/cli.mjs`
  命令行入口
- `src/bridge.mjs`
  主桥接运行时
- `src/ironclaw-client.mjs`
  `IronClaw` gateway API 与 SSE 客户端
- `src/weixin-api.mjs`
  微信 bot HTTP API 封装
- `src/media.mjs`
  微信媒体下载、解密、上传、data URL 和文件处理
- `src/store.mjs`
  本地状态持久化

## 设计说明

### 1. 为什么不用 `openclaw-weixin-cli`

腾讯提供的：

- `@tencent-weixin/openclaw-weixin-cli`
- `@tencent-weixin/openclaw-weixin`

是给 `OpenClaw` 体系准备的。

它们内部写死了：

- `openclaw plugins install`
- `openclaw channels login`
- `openclaw gateway restart`

所以不能直接拿来给 `IronClaw` 用。

这个项目的目标就是把这条依赖链彻底切掉，改成：

`微信协议 <-> 本桥接器 <-> IronClaw gateway`

### 2. 为什么不直接改成 IronClaw 原生 channel

可以做，但那是下一阶段的事情。

先做成独立桥接器有几个现实优势：

- 不需要改 `IronClaw` 源码
- 可单独部署、单独回滚
- 协议层容易测试
- 更适合快速开源迭代

### 3. 上下文隔离怎么做

每个：

- `accountId`
- `peerId`

都会映射到一个独立的 `IronClaw thread`。

这样微信不同用户之间不会串上下文。

### 4. 媒体怎么处理

- 微信图片：尽量解密后直接作为 `IronClaw` 图片输入
- 微信文件/视频/语音：先落本地文件，再把路径信息附加给 `IronClaw`
- `IronClaw` 生成图片：通过 `image_generated` SSE 回发微信
- `IronClaw` 回复里的图片 URL / 本地文件路径：桥接器会尽量识别并作为微信媒体发送

## 开源建议

如果你要正式发布，建议至少补这三样：

1. `systemd` service 示例
2. 一份生产部署说明
3. 一轮真实环境联调记录

这个仓库当前已经具备一个可继续迭代的基础版本，适合作为第一版开源起点。

## npm 发布

如果你要把它发布成可以被 `npx` 直接执行的 npm 包，建议按这个顺序做：

1. 修改 [package.json](/root/ironclaw-weixin-bridge/package.json) 里的 `name`，换成你准备发布的包名。
2. 先运行一次 `npm test`。
3. 运行 `npm run pack:check`，确认真正会被打包的文件只有源码、许可证、README 和示例配置。
4. 执行 `npm login`。
5. 首次发布公开包时执行 `npm publish --access public`。

发布成功后，用户就可以直接：

```bash
npx <你的包名> help
npx <你的包名> login --config ./config.local.json --account default
npx <你的包名> run --config ./config.local.json
```

## 发布前检查

建议每次发布前至少过一遍下面这份清单：

1. 确认 `config.json`、`config.example.json` 中没有真实 token、真实账号或机器专属路径。
2. 确认 `state/`、`bridge.out`、`bridge.pid`、`config.local.json` 这类本地运行产物没有进入仓库。
3. 运行一次 `npm test`，确保主流程测试仍然全绿。
4. 至少做一轮真实联调：扫码登录、收一条文本、回一条文本，如有媒体能力改动再补一轮图片联调。
5. 检查 README 里的命令、配置字段和当前代码一致，避免文档落后于实现。
