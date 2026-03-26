# ironclaw-weixin-bridge

`ironclaw-weixin-bridge` 是一个把微信消息桥接到 `IronClaw` 的工具。

作用：

- 扫码登录微信 bot
- 接收微信消息
- 转发给 `IronClaw`
- 把 `IronClaw` 回复回发到微信

## 使用方式

要求：

- 本机已安装并可运行 `ironclaw`
- 本机已启用 `IronClaw` gateway
- Node.js 22+

最短用法：

```bash
npx ironclaw-weixin-bridge run
```

说明：

- 如果本地还没登录，会先在终端打印二维码
- 你扫码后，程序会自动继续运行
- 如果本地已经登录，会直接开始桥接

如果你用源码仓库运行：

```bash
cd /root/ironclaw-weixin-bridge-repo
npm install
node ./src/cli.mjs run
```

如果你只想单独登录：

```bash
node ./src/cli.mjs login --account default
```

状态目录默认在：

```text
~/.ironclaw-weixin-bridge
```

登录态会保存到：

```text
~/.ironclaw-weixin-bridge/accounts/default.json
```

## 后台常驻

仓库里已经提供 `systemd` 服务文件：

- [deploy/systemd/ironclaw-weixin-bridge.service](/root/ironclaw-weixin-bridge-repo/deploy/systemd/ironclaw-weixin-bridge.service)
- [deploy/systemd/install-service.sh](/root/ironclaw-weixin-bridge-repo/deploy/systemd/install-service.sh)

安装并启动：

```bash
cd /root/ironclaw-weixin-bridge-repo
chmod +x ./deploy/systemd/install-service.sh
sudo ./deploy/systemd/install-service.sh
```

常用命令：

```bash
systemctl start ironclaw-weixin-bridge.service
systemctl stop ironclaw-weixin-bridge.service
systemctl restart ironclaw-weixin-bridge.service
systemctl status ironclaw-weixin-bridge.service --no-pager
journalctl -u ironclaw-weixin-bridge.service -f
```

服务特性：

- 开机自启
- 后台常驻
- 挂了自动重启
