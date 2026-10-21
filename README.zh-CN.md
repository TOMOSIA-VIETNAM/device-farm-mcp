# Device Farm MCP - 在 AWS Device Farm 和本地设备上自动化 iOS 与 Android 的 MCP 服务器

[English](README.md) | [日本語](README.ja.md) | **简体中文**

Device Farm MCP 是一个 MCP 服务器，让 AI 智能体通过一套与平台无关的工具操作 iOS 和 Android 设备。支持的目标包括：

- **[AWS Device Farm](https://aws.amazon.com/device-farm/) 中的真机**：按需以远程访问会话（remote access session）的形式预留，并通过会话托管的 Appium 端点进行控制。
- **你本机上的设备**：iOS 模拟器、Android 仿真器，以及通过 USB 连接的真机。

智能体通过结构化的无障碍快照与应用交互，必要时才回退到基于截图的坐标点击。

**支持 Claude Code、Codex、Gemini、GitHub Copilot、Cursor** 以及任何兼容 MCP 的客户端。

<h4 align="center">
  <a href="https://www.npmjs.com/package/@tomosia/device-farm-mcp">
    <img src="https://img.shields.io/npm/v/@tomosia/device-farm-mcp?logo=npm&style=flat&color=red" alt="npm" />
  </a>
  <a href="https://github.com/TOMOSIA-VIETNAM/device-farm-mcp/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/TOMOSIA-VIETNAM/device-farm-mcp" alt="license" />
  </a>
</h4>

> Device Farm MCP 是 [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) 的分支（fork）。远程设备来自 AWS Device Farm，而不是 Mobile Next Cloud；本地设备支持保持不变。

## 目录

- [工作原理](#工作原理)
- [前提条件](#前提条件)
- [配置 AWS Device Farm](#配置-aws-device-farm)
- [安装 MCP 服务器](#安装-mcp-服务器)
- [验证安装](#验证安装)
- [使用远程设备](#使用远程设备)
- [可用的 MCP 工具](#可用的-mcp-工具)
- [本地设备](#本地设备)
- [Streamable HTTP 服务器模式](#streamable-http-服务器模式)
- [环境变量](#环境变量)
- [示例提示词](#示例提示词)

## 工作原理

```
 MCP client (Claude Code, Cursor, ...)
        │  stdio / Streamable HTTP
        ▼
 device-farm-mcp ──── local device id ────► mobilecli ──► simulator / emulator / USB device
        │
        └──── session ARN ──► AWS Device Farm API (us-west-2)
                                 │  CreateRemoteAccessSession, uploads, install
                                 ▼
                          remote access session ──► managed Appium endpoint ──► real device
```

1. `mobile_list_remote_devices` 列出支持远程访问的 Device Farm 设备。
2. `mobile_allocate_remote_device` 在你的 Device Farm 项目中启动远程访问会话。返回的**会话 ARN** 就是其他所有 `mobile_*` 工具使用的设备 ID。
3. 发往该设备的所有命令都会发送到会话的 Appium 端点。
4. `mobile_release_remote_device` 停止会话，同时停止计费。

身份验证使用 AWS 标准凭证链，因此无需单独的登录步骤。

## 前提条件

- [Node.js](https://nodejs.org/en/download/) v20 及以上
- 可以使用 AWS Device Farm 的 AWS 账号。Device Farm 仅在 **`us-west-2`** 区域提供，服务器始终使用该区域。
- 运行服务器的机器上配置好的 AWS 凭证（见下文）
- 兼容 MCP 的客户端或智能体

如需使用本地设备，还需要 [Xcode 命令行工具](https://developer.apple.com/xcode/resources/)（iOS）和/或 [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools)（Android）。

## 配置 AWS Device Farm

### 1. 授予 IAM 权限

运行服务器的 IAM 用户或角色需要以下 Device Farm 操作权限：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "devicefarm:ListDevices",
        "devicefarm:CreateRemoteAccessSession",
        "devicefarm:GetRemoteAccessSession",
        "devicefarm:StopRemoteAccessSession",
        "devicefarm:CreateUpload",
        "devicefarm:GetUpload",
        "devicefarm:InstallToRemoteAccessSession"
      ],
      "Resource": "*"
    }
  ]
}
```

如果还想用同一身份通过 AWS CLI 管理项目，请额外添加 `devicefarm:ListProjects` 和 `devicefarm:CreateProject`。

### 2. 配置 AWS 凭证

AWS SDK 支持的任何方式都可以：

- 环境变量：`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`（临时凭证还需 `AWS_SESSION_TOKEN`）
- `~/.aws/credentials` / `~/.aws/config` 中的配置文件（profile），通过 `AWS_PROFILE` 选择
- AWS IAM Identity Center：`aws sso login --profile <profile>`

确认该身份可以访问 Device Farm：

```bash
aws devicefarm list-devices --region us-west-2 --query 'length(devices)'
```

### 3. 创建或选择 Device Farm 项目

远程访问会话和应用上传都属于某个项目。列出已有项目，或新建一个：

```bash
aws devicefarm list-projects --region us-west-2 --query 'projects[].[name,arn]' --output table
aws devicefarm create-project --name device-farm-mcp --region us-west-2 --query 'project.arn' --output text
```

复制项目 ARN，填入 MCP 服务器配置中的 `DEVICEFARM_PROJECT_ARN`。

## 安装 MCP 服务器

适用于大多数客户端的**标准配置**：

```json
{
  "mcpServers": {
    "device-farm-mcp": {
      "command": "npx",
      "args": ["-y", "@tomosia/device-farm-mcp@latest"],
      "env": {
        "DEVICEFARM_PROJECT_ARN": "arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234",
        "AWS_PROFILE": "default"
      }
    }
  }
}
```

- 预留设备和安装应用需要 `DEVICEFARM_PROJECT_ARN`。列出远程设备和使用本地设备不需要它。
- `AWS_PROFILE` 是可选的。省略时使用默认凭证链，也可以换成 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`。
- MCP 客户端启动服务器时通常不会继承你的 shell 环境，因此请把 AWS 相关变量写在 `env` 中，而不要依赖 shell 配置文件里的 `export`。

**从本地代码运行**（用于测试修改，或在版本发布之前使用）：

```bash
git clone https://github.com/TOMOSIA-VIETNAM/device-farm-mcp.git
cd device-farm-mcp
npm install && npm run build
```

然后用 `node` 指向 `lib/index.js`，代替 `npx`：

```json
{
  "mcpServers": {
    "device-farm-mcp": {
      "command": "node",
      "args": ["/path/to/device-farm-mcp/lib/index.js"],
      "env": {
        "DEVICEFARM_PROJECT_ARN": "arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234"
      }
    }
  }
}
```

### 各客户端的配置

以下所有示例都需要加上标准配置中的 `env` 值。

<details>
<summary>Claude Code</summary>

使用 Claude Code CLI 添加服务器：

```bash
claude mcp add device-farm-mcp \
  -e DEVICEFARM_PROJECT_ARN=arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234 \
  -e AWS_PROFILE=default \
  -- npx -y @tomosia/device-farm-mcp@latest
```

或者在 Claude Code 中安装插件，它会添加 MCP 服务器和 `/mobile-mirror`：

```
/plugin marketplace add TOMOSIA-VIETNAM/device-farm-mcp
/plugin install device-farm-mcp@device-farm-mcp
```

插件启动服务器时不会传入 `DEVICEFARM_PROJECT_ARN`，因此使用远程设备时，请在启动 Claude Code 的环境中设置该变量（以及所需的 AWS 变量）。

`/mobile-mirror [device-id]` 会打开一个显示设备实时画面的窗格。点击画面即可点击设备，键盘输入会发送按键，上方还有 Home、Back、App Switch 和 URL 按钮。需要支持 kitty graphics protocol 的终端，例如 kitty 或 Ghostty。

</details>

<details>
<summary>Claude Desktop</summary>

按照 [MCP 安装指南](https://modelcontextprotocol.io/quickstart/user)操作，使用上面的标准配置。

</details>

<details>
<summary>Codex</summary>

```bash
codex mcp add device-farm-mcp \
  --env DEVICEFARM_PROJECT_ARN=arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234 \
  -- npx -y @tomosia/device-farm-mcp@latest
```

或编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.device-farm-mcp]
command = "npx"
args = ["-y", "@tomosia/device-farm-mcp@latest"]

[mcp_servers.device-farm-mcp.env]
DEVICEFARM_PROJECT_ARN = "arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234"
AWS_PROFILE = "default"
```

</details>

<details>
<summary>Copilot CLI</summary>

在 Copilot CLI 中运行 `/mcp add`，或编辑 `~/.copilot/mcp-config.json`：

```json
{
  "mcpServers": {
    "device-farm-mcp": {
      "type": "local",
      "command": "npx",
      "tools": ["*"],
      "args": ["-y", "@tomosia/device-farm-mcp@latest"],
      "env": {
        "DEVICEFARM_PROJECT_ARN": "arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234"
      }
    }
  }
}
```

</details>

<details>
<summary>Cursor</summary>

前往 `Cursor Settings` -> `MCP` -> `Add new MCP Server` 添加，或将标准配置写入 `~/.cursor/mcp.json`（全局）或 `.cursor/mcp.json`（项目）。

</details>

<details>
<summary>Gemini CLI</summary>

```bash
gemini mcp add device-farm-mcp \
  -e DEVICEFARM_PROJECT_ARN=arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234 \
  npx -y @tomosia/device-farm-mcp@latest
```

</details>

<details>
<summary>VS Code</summary>

添加到 `.vscode/mcp.json`：

```json
{
  "servers": {
    "device-farm-mcp": {
      "command": "npx",
      "args": ["-y", "@tomosia/device-farm-mcp@latest"],
      "env": {
        "DEVICEFARM_PROJECT_ARN": "arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234"
      }
    }
  }
}
```

</details>

<details>
<summary>Cline、Kiro、Windsurf、Amp、opencode、Goose</summary>

将标准配置添加到客户端的 MCP 设置中。对于只接受单条命令的客户端，使用 `npx -y @tomosia/device-farm-mcp@latest`，并在客户端的环境变量设置中指定 `DEVICEFARM_PROJECT_ARN`。

</details>

## 验证安装

向智能体提问：

```text
显示我可以使用的远程设备
```

如果返回包含名称、平台、系统版本和可用状态的 Device Farm 设备列表，说明配置成功。如果出现凭证错误，请检查[配置 AWS Device Farm](#配置-aws-device-farm)中的步骤。

对于本地设备，可以问「列出可用设备」，它会返回正在运行的模拟器、仿真器以及已连接的设备。

## 使用远程设备

一个典型的会话：

```text
从 Device Farm 预留一台 Android 14 或更高版本的 Android 设备，等它准备就绪后安装
./build/app-release.apk，打开应用并用测试账号登录。完成后释放设备。
```

背后的执行过程：

| 步骤 | 工具 | 说明 |
|---|---|---|
| 查找设备 | `mobile_list_remote_devices` | 只列出启用了远程访问的设备。 |
| 预留设备 | `mobile_allocate_remote_device` | 可按 `platform`（必填）、`name`（完全匹配，或以 `*` 结尾进行前缀匹配，例如 `Google Pixel*`）和 `version`（例如 `">=14"`、`"18.6.2"`）筛选。设置 `wait: true` 时会阻塞等待会话进入运行状态，最长 `timeoutSeconds`（默认 900）秒。优先选择可用性高的设备。 |
| 安装应用 | `mobile_install_app` | 将本地文件上传到项目，等待 Device Farm 处理完成后安装到会话中。Android 仅支持 `.apk`，iOS 仅支持 `.ipa`。 |
| 操作应用 | 其他 `mobile_*` 工具 | 将会话 ARN 作为 `device` 传入。 |
| 释放设备 | `mobile_release_remote_device` | 停止会话和计费。已安装的应用和设备状态会被清除。 |

### 费用与限制

- 会话运行期间，Device Farm **按设备分钟计费**。智能体会被要求在预留设备前征得同意，并在任务完成后释放设备，但请留意 AWS 账单，并释放不再需要的会话。
- 会话在 **150 分钟**后，或 **5 分钟内没有任何命令**时会自动结束。
- 可以在 AWS 控制台的 **Device Farm → Projects → Remote access** 中查看和停止会话，或使用命令：
  ```bash
  aws devicefarm list-remote-access-sessions --region us-west-2 --arn <project-arn>
  aws devicefarm stop-remote-access-session --region us-west-2 --arn <session-arn>
  ```

### 远程设备的限制

远程设备通过 Appium 控制，因此部分工具仅适用于本地设备：

- 屏幕录制、设备日志和崩溃报告
- GPS 位置覆盖、剪贴板和折叠
- 通过元素 `ref` 点击（请改用 `mobile_list_elements_on_screen` 返回的坐标）
- 以指定语言区域（locale）启动应用

## 可用的 MCP 工具

### 设备管理
- **`mobile_list_available_devices`** - 列出本地设备（模拟器、仿真器和真机）
- **`mobile_get_screen_size`** - 获取设备屏幕尺寸（像素）
- **`mobile_get_orientation`** - 获取当前屏幕方向
- **`mobile_set_orientation`** - 更改屏幕方向（竖屏/横屏）
- **`mobile_fold_device`** - 折叠或展开可折叠设备（仅本地）
- **`mobile_set_location`** - 覆盖设备上报的 GPS 位置，或清除覆盖（仅本地）
- **`mobile_clipboard`** - 读取或替换设备剪贴板（仅本地）

### 远程设备（AWS Device Farm）
- **`mobile_list_remote_devices`** - 列出支持远程访问的 AWS Device Farm 设备
- **`mobile_allocate_remote_device`** - 在匹配的设备上启动远程访问会话；会话 ARN 即其他工具使用的设备 ID
- **`mobile_release_remote_device`** - 停止远程访问会话

### 应用管理
- **`mobile_list_apps`** - 列出已安装的应用
- **`mobile_get_foreground_app`** - 获取当前前台应用
- **`mobile_launch_app`** - 按包名或 Bundle ID 启动应用
- **`mobile_terminate_app`** - 停止正在运行的应用
- **`mobile_install_app`** - 从文件安装应用（本地支持 .apk、.ipa、.app、.zip；Device Farm 支持 .apk / .ipa）
- **`mobile_uninstall_app`** - 按包名或 Bundle ID 卸载应用

### 屏幕交互
- **`mobile_take_screenshot`** - 截图以了解屏幕内容
- **`mobile_save_screenshot`** - 将截图保存到文件
- **`mobile_list_elements_on_screen`** - 列出 UI 元素及其坐标和属性
- **`mobile_click_on_screen_at_coordinates`** - 点击 x,y 坐标或通过 ref 指定的元素
- **`mobile_double_tap_on_screen`** - 双击坐标或通过 ref 指定的元素
- **`mobile_long_press_on_screen_at_coordinates`** - 长按坐标或通过 ref 指定的元素
- **`mobile_swipe_on_screen`** - 向任意方向滑动
- **`mobile_start_screen_recording`** - 开始录制屏幕到视频文件（仅本地）
- **`mobile_stop_screen_recording`** - 停止录制并保存视频（仅本地）

### 输入与导航
- **`mobile_type_keys`** - 向当前聚焦的元素输入文本，可选择提交
- **`mobile_press_button`** - 按下设备按键（HOME、BACK、VOLUME_UP/DOWN、ENTER 等）
- **`mobile_open_url`** - 在设备浏览器中打开 http/https 链接

### 日志与崩溃报告（仅本地）
- **`mobile_get_device_logs`** - 收集设备实时日志（Android 为 logcat，iOS 为 unified log），可保存到文件
- **`mobile_list_crashes`** - 列出设备上的崩溃报告
- **`mobile_get_crash`** - 按 ID 获取崩溃报告的完整内容

### 批量执行
- **`mobile_batch_commands`** - 在一次调用中依次执行多个工具（例如点击、输入、点击），可选择在最后列出屏幕元素

## 本地设备

本地设备通过 [mobilecli](https://github.com/mobile-next/mobilecli) 控制，无需任何 AWS 配置。

| 目标 | 配置 |
|---|---|
| iOS 模拟器 | Xcode 和已启动的模拟器（`xcrun simctl boot "iPhone 16"`） |
| iOS 真机 | 通过 USB 连接并已信任 |
| Android 仿真器 | Android SDK 和正在运行的仿真器（`adb devices`） |
| Android 真机 | `adb`，并已启用和授权 USB 调试 |

当没有可用的本地设备时，智能体会改为建议使用 Device Farm 设备，并在预留之前征得你的同意。

## Streamable HTTP 服务器模式

服务器默认通过 stdio 运行。如需改为启动 [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) 服务器，请使用 `--listen`：

```bash
npx @tomosia/device-farm-mcp@latest --listen 3000          # 绑定到 localhost:3000
npx @tomosia/device-farm-mcp@latest --listen 0.0.0.0:3000  # 绑定到所有网络接口
```

客户端连接 `http://<host>:3000/mcp`。该端点是无状态的，因此可以在负载均衡器后面运行，无需会话亲和性。绑定到 localhost 时，会自动启用基于 Host 头的 DNS 重绑定防护。

服务器使用所在主机的 AWS 凭证，因此任何能访问服务器的人都可以用该账号预留 Device Farm 设备。在 localhost 之外公开时，请通过 `DEVICE_FARM_MCP_AUTH` 要求 Bearer 令牌：

```bash
DEVICE_FARM_MCP_AUTH=my-secret-token npx @tomosia/device-farm-mcp@latest --listen 0.0.0.0:3000
```

设置后，所有请求都必须带上 `Authorization: Bearer my-secret-token`。未设置 `DEVICE_FARM_MCP_AUTH` 时，服务器会接受未经身份验证的连接并记录警告。

## 环境变量

| 变量 | 说明 | 示例 |
|---|---|---|
| `DEVICEFARM_PROJECT_ARN` | 用于远程访问会话和应用上传的 AWS Device Farm 项目。 | `arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234` |
| `AWS_PROFILE`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN` | AWS SDK 标准凭证。默认凭证链中的其他方式同样适用。 | `AWS_PROFILE=devicefarm` |
| `DEVICE_FARM_MCP_AUTH` | 在 Streamable HTTP 服务器（`--listen`）上要求 Bearer 令牌。 | `my-secret-token` |
| `DEVICE_FARM_MCP_DISABLE_TELEMETRY` | 禁用匿名使用遥测（PostHog 和 Scarf）。 | `1` |
| `DEVICE_FARM_MCP_ALLOW_UNSAFE_URLS` | 允许 `mobile_open_url` 打开非标准 URL 协议（默认阻止）。 | `1` |
| `DEVICE_FARM_MCP_LEGACY_ROBOT` | 对本地 Android 设备和 iOS 真机使用旧版的平台专用 robot。iOS 模拟器仍使用 `mobilecli`。 | `1` |

## 示例提示词

描述要具体、直接。合适的工具由智能体选择。

**在多台设备上对构建做冒烟测试**
```text
对 Device Farm 上的 "Google Pixel 8" 和 "Samsung Galaxy S24" 分别执行：预留设备，安装
./build/app-release.apk，启动应用，完成新手引导，截取主屏幕截图，然后释放设备。
如果有显示异常的页面，请报告。
```

**在 iOS 上检查流程**
```text
预留一台 iOS 18 或更高版本的 iPhone，安装 ./build/MyApp.ipa，用一个新的测试邮箱注册，
并确认个人资料页面显示了该邮箱。完成后释放设备。
```

**在本地模拟器上操作**
```text
在已启动的 iOS 模拟器上打开设置，搜索「Wi-Fi」，告诉我当前连接的是哪个网络。
```

## 贡献

欢迎贡献。构建、测试和提交 Pull Request 的方法请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)，也可以浏览[未解决的 issue](https://github.com/TOMOSIA-VIETNAM/device-farm-mcp/issues)。同时请阅读我们的[行为准则](CODE_OF_CONDUCT.md)。

## 致谢

Device Farm MCP 基于 [Mobile Next](https://github.com/mobile-next) 的 [mobile-mcp](https://github.com/mobile-next/mobile-mcp) 和 [mobilecli](https://github.com/mobile-next/mobilecli) 构建，二者均采用 Apache-2.0 许可证。

## 隐私

服务器运行在你的机器上（HTTP 模式下则运行在你的主机上）。它与你的本地设备通信，对于远程设备，则使用你的凭证与 AWS Device Farm 通信。安装到远程设备上的应用会上传到你的 Device Farm 项目。除非设置 `DEVICE_FARM_MCP_DISABLE_TELEMETRY=1`，否则会发送匿名使用遥测数据。详情请参阅 Mobile Next 隐私政策：https://mobilenext.ai/privacy。
