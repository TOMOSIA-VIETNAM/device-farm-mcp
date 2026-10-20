# Device Farm MCP - MCP server for iOS and Android automation on AWS Device Farm and local devices

**English** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

Device Farm MCP is an MCP server that lets AI agents drive iOS and Android devices through one platform-agnostic set of tools. It runs against:

- **Real devices in [AWS Device Farm](https://aws.amazon.com/device-farm/)**, reserved on demand as remote access sessions and controlled through the session's managed Appium endpoint.
- **Devices on your own machine**: iOS simulators, Android emulators, and USB-connected real devices.

Agents interact with apps through structured accessibility snapshots, falling back to coordinate taps based on screenshots when needed.

**Works with Claude Code, Codex, Gemini, GitHub Copilot, Cursor** or any other MCP-compatible client.

<h4 align="center">
  <a href="https://www.npmjs.com/package/@tomosia/device-farm-mcp">
    <img src="https://img.shields.io/npm/v/@tomosia/device-farm-mcp?logo=npm&style=flat&color=red" alt="npm" />
  </a>
  <a href="https://github.com/TOMOSIA-VIETNAM/device-farm-mcp/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/TOMOSIA-VIETNAM/device-farm-mcp" alt="license" />
  </a>
</h4>

> Device Farm MCP is a fork of [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp). Remote devices come from AWS Device Farm instead of Mobile Next Cloud; local device support is unchanged.

## Contents

- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Set up AWS Device Farm](#set-up-aws-device-farm)
- [Install the MCP server](#install-the-mcp-server)
- [Verify it works](#verify-it-works)
- [Using remote devices](#using-remote-devices)
- [Available MCP tools](#available-mcp-tools)
- [Local devices](#local-devices)
- [Streamable HTTP server mode](#streamable-http-server-mode)
- [Environment variables](#environment-variables)
- [Example prompts](#example-prompts)

## How it works

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

1. `mobile_list_remote_devices` lists Device Farm devices that support remote access.
2. `mobile_allocate_remote_device` starts a remote access session in your Device Farm project. The returned **session ARN** is the device id for every other `mobile_*` tool.
3. Every command for that device goes to the session's Appium endpoint.
4. `mobile_release_remote_device` stops the session, which stops billing.

Authentication uses the standard AWS credential chain, so there is no separate login step.

## Prerequisites

- [Node.js](https://nodejs.org/en/download/) v20+
- An AWS account with access to AWS Device Farm. Device Farm runs only in **`us-west-2`**, and the server always uses that region.
- AWS credentials on the machine that runs the server (see below)
- An MCP-compatible client or agent

For local devices you also need [Xcode command line tools](https://developer.apple.com/xcode/resources/) (iOS) and/or [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools) (Android).

## Set up AWS Device Farm

### 1. Grant IAM permissions

The IAM user or role that the server runs as needs these Device Farm actions:

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

Add `devicefarm:ListProjects` and `devicefarm:CreateProject` if you also want to manage projects from the AWS CLI with the same identity.

### 2. Configure AWS credentials

Any method supported by the AWS SDK works:

- Environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN` for temporary credentials)
- A profile in `~/.aws/credentials` / `~/.aws/config`, selected with `AWS_PROFILE`
- AWS IAM Identity Center: `aws sso login --profile <profile>`

Check that the identity can reach Device Farm:

```bash
aws devicefarm list-devices --region us-west-2 --query 'length(devices)'
```

### 3. Create or pick a Device Farm project

Remote access sessions and app uploads belong to a project. List existing projects, or create one:

```bash
aws devicefarm list-projects --region us-west-2 --query 'projects[].[name,arn]' --output table
aws devicefarm create-project --name device-farm-mcp --region us-west-2 --query 'project.arn' --output text
```

Copy the project ARN. It goes into `DEVICEFARM_PROJECT_ARN` in the MCP server config.

## Install the MCP server

**Standard config**, which works in most clients:

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

- `DEVICEFARM_PROJECT_ARN` is required for allocating devices and installing apps. Listing remote devices and using local devices work without it.
- `AWS_PROFILE` is optional. Drop it to use the default credential chain, or replace it with `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.
- MCP clients often start servers without your shell environment, so set AWS variables in `env` rather than relying on `export` in your shell profile.

**Running from a local checkout** (to test changes, or before a release is published):

```bash
git clone https://github.com/TOMOSIA-VIETNAM/device-farm-mcp.git
cd device-farm-mcp
npm install && npm run build
```

Then point the client at `lib/index.js` with `node` instead of `npx`:

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

### Client-specific setup

In every example below, add the `env` values from the standard config.

<details>
<summary>Claude Code</summary>

Add the server with the Claude Code CLI:

```bash
claude mcp add device-farm-mcp \
  -e DEVICEFARM_PROJECT_ARN=arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234 \
  -e AWS_PROFILE=default \
  -- npx -y @tomosia/device-farm-mcp@latest
```

Or install the plugin from inside Claude Code. It adds the MCP server and `/mobile-mirror`:

```
/plugin marketplace add TOMOSIA-VIETNAM/device-farm-mcp
/plugin install mobile-mcp@mobile-mcp
```

The plugin starts the server without `DEVICEFARM_PROJECT_ARN`, so for remote devices set it (and any AWS variables) in the environment Claude Code is launched from.

`/mobile-mirror [device-id]` opens a pane with the device's live screen. Click the picture to tap, type to send keys, and use the Home, Back, App Switch and URL buttons above it. It needs a terminal with the kitty graphics protocol, such as kitty or Ghostty.

</details>

<details>
<summary>Claude Desktop</summary>

Follow the [MCP install guide](https://modelcontextprotocol.io/quickstart/user) and use the standard config above.

</details>

<details>
<summary>Codex</summary>

```bash
codex mcp add device-farm-mcp \
  --env DEVICEFARM_PROJECT_ARN=arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234 \
  -- npx -y @tomosia/device-farm-mcp@latest
```

Or edit `~/.codex/config.toml`:

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

Run `/mcp add` inside the Copilot CLI, or edit `~/.copilot/mcp-config.json`:

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

Go to `Cursor Settings` -> `MCP` -> `Add new MCP Server`, or add the standard config to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).

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

Add to `.vscode/mcp.json`:

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
<summary>Cline, Kiro, Windsurf, Amp, opencode, Goose</summary>

Add the standard config to the client's MCP settings. For clients that take a single command, use `npx -y @tomosia/device-farm-mcp@latest` and set `DEVICEFARM_PROJECT_ARN` in the client's environment settings.

</details>

## Verify it works

Ask your agent:

```text
show me which remote devices are available to me
```

You should get a list of Device Farm devices with name, platform, OS version and availability. If you get a credentials error instead, check the steps in [Set up AWS Device Farm](#set-up-aws-device-farm).

For local devices, ask `list available devices`. That returns running simulators, emulators and connected devices.

## Using remote devices

A typical session:

```text
Allocate an Android device running Android 14 or newer from Device Farm, wait until it is ready,
install ./build/app-release.apk, open the app and log in with the test account.
Release the device when you are done.
```

What happens under the hood:

| Step | Tool | Notes |
|---|---|---|
| Find a device | `mobile_list_remote_devices` | Only devices with remote access enabled are listed. |
| Reserve it | `mobile_allocate_remote_device` | Filter by `platform` (required), `name` (exact, or prefix with a trailing `*`, e.g. `Google Pixel*`) and `version` (e.g. `">=14"`, `"18.6.2"`). With `wait: true` it blocks until the session is running, up to `timeoutSeconds` (default 900). Highly available devices are preferred. |
| Install the app | `mobile_install_app` | Uploads the local file to the project, waits for Device Farm to process it, then installs it into the session. Android accepts `.apk`, iOS accepts `.ipa`. |
| Drive the app | other `mobile_*` tools | Pass the session ARN as `device`. |
| Release it | `mobile_release_remote_device` | Stops the session and billing. Installed apps and device state are wiped. |

### Costs and limits

- Device Farm **bills per device minute** while a session is running. Agents are instructed to ask before allocating a device and to release it when the task is done, but check your AWS bill and release sessions you no longer need.
- A session ends on its own after **150 minutes**, or after **5 minutes without any command**.
- You can see and stop sessions in the AWS console under **Device Farm → Projects → Remote access**, or with:
  ```bash
  aws devicefarm list-remote-access-sessions --region us-west-2 --arn <project-arn>
  aws devicefarm stop-remote-access-session --region us-west-2 --arn <session-arn>
  ```

### Remote device limitations

Remote devices are driven through Appium, so some tools only work on local devices:

- screen recording, device logs and crash reports
- GPS location override, clipboard, and folding
- tapping by element `ref` (use coordinates from `mobile_list_elements_on_screen` instead)
- launching an app with a specific locale

## Available MCP tools

### Device management
- **`mobile_list_available_devices`** - List local devices (simulators, emulators, and real devices)
- **`mobile_get_screen_size`** - Get the screen size of the device in pixels
- **`mobile_get_orientation`** - Get the current screen orientation
- **`mobile_set_orientation`** - Change the screen orientation (portrait/landscape)
- **`mobile_fold_device`** - Fold or unfold a foldable device (local only)
- **`mobile_set_location`** - Override the GPS location reported by the device, or clear the override (local only)
- **`mobile_clipboard`** - Read or replace the device clipboard (local only)

### Remote devices (AWS Device Farm)
- **`mobile_list_remote_devices`** - List AWS Device Farm devices that support remote access
- **`mobile_allocate_remote_device`** - Start a remote access session on a matching device; the session ARN is the device id for the other tools
- **`mobile_release_remote_device`** - Stop the remote access session

### App management
- **`mobile_list_apps`** - List installed apps
- **`mobile_get_foreground_app`** - Get the app currently in the foreground
- **`mobile_launch_app`** - Launch an app by package name or bundle ID
- **`mobile_terminate_app`** - Stop a running app
- **`mobile_install_app`** - Install an app from a file (.apk, .ipa, .app, .zip locally; .apk / .ipa on Device Farm)
- **`mobile_uninstall_app`** - Uninstall an app by package name or bundle ID

### Screen interaction
- **`mobile_take_screenshot`** - Take a screenshot to understand what's on screen
- **`mobile_save_screenshot`** - Save a screenshot to a file
- **`mobile_list_elements_on_screen`** - List UI elements with their coordinates and properties
- **`mobile_click_on_screen_at_coordinates`** - Click at x,y coordinates or on an element by its ref
- **`mobile_double_tap_on_screen`** - Double-tap at coordinates or on an element by its ref
- **`mobile_long_press_on_screen_at_coordinates`** - Long press at coordinates or on an element by its ref
- **`mobile_swipe_on_screen`** - Swipe in any direction
- **`mobile_start_screen_recording`** - Start recording the screen to a video file (local only)
- **`mobile_stop_screen_recording`** - Stop the recording and save the video (local only)

### Input and navigation
- **`mobile_type_keys`** - Type text into the focused element, optionally submitting
- **`mobile_press_button`** - Press device buttons (HOME, BACK, VOLUME_UP/DOWN, ENTER, etc.)
- **`mobile_open_url`** - Open http/https URLs in the device browser

### Logs and crash reports (local only)
- **`mobile_get_device_logs`** - Collect live device logs (logcat on Android, unified log on iOS), optionally saved to a file
- **`mobile_list_crashes`** - List crash reports on the device
- **`mobile_get_crash`** - Get the full content of a crash report by ID

### Batching
- **`mobile_batch_commands`** - Run multiple tools in sequence in one call (e.g. click, type, click), optionally listing screen elements at the end

## Local devices

Local devices are controlled through [mobilecli](https://github.com/mobile-next/mobilecli) and need no AWS setup.

| Target | Setup |
|---|---|
| iOS Simulator | Xcode and a booted simulator (`xcrun simctl boot "iPhone 16"`) |
| iOS real device | Device connected over USB and trusted |
| Android Emulator | Android SDK and a running emulator (`adb devices`) |
| Android real device | `adb` with USB debugging enabled and authorized |

When no local device is available, the agent offers a Device Farm device instead and asks before allocating it.

## Streamable HTTP server mode

The server runs over stdio by default. To start a [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) server instead, use `--listen`:

```bash
npx @tomosia/device-farm-mcp@latest --listen 3000          # binds to localhost:3000
npx @tomosia/device-farm-mcp@latest --listen 0.0.0.0:3000  # binds to all interfaces
```

Clients connect to `http://<host>:3000/mcp`. The endpoint is stateless, so it works behind load balancers without session affinity. When bound to localhost, Host-header DNS rebinding protection is enabled automatically.

The server uses the AWS credentials of the host it runs on, so everyone who can reach it can allocate Device Farm devices on that account. Require a Bearer token with `MOBILEMCP_AUTH` when exposing it beyond localhost:

```bash
MOBILEMCP_AUTH=my-secret-token npx @tomosia/device-farm-mcp@latest --listen 0.0.0.0:3000
```

Every request must then send `Authorization: Bearer my-secret-token`. Without `MOBILEMCP_AUTH` the server accepts unauthenticated connections and logs a warning.

## Environment variables

| Variable | Description | Example |
|---|---|---|
| `DEVICEFARM_PROJECT_ARN` | AWS Device Farm project used for remote access sessions and app uploads. | `arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234` |
| `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Standard AWS SDK credentials. Any other method of the default credential chain also works. | `AWS_PROFILE=devicefarm` |
| `MOBILEMCP_AUTH` | Require a Bearer token on the Streamable HTTP server (`--listen`). | `my-secret-token` |
| `MOBILEMCP_DISABLE_TELEMETRY` | Disable anonymous usage telemetry (PostHog and Scarf). | `1` |
| `MOBILEMCP_ALLOW_UNSAFE_URLS` | Allow `mobile_open_url` to open non-standard URL schemes (blocked by default). | `1` |
| `MOBILEMCP_LEGACY_ROBOT` | Use the legacy platform-specific robots for local Android devices and physical iOS devices. iOS simulators still use `mobilecli`. | `1` |

## Example prompts

Be descriptive and to the point. The agent picks the right tools.

**Smoke test a build on several devices**
```text
For each of "Google Pixel 8" and "Samsung Galaxy S24" on Device Farm: allocate it, install
./build/app-release.apk, launch the app, go through onboarding, take a screenshot of the
home screen, and release the device. Report any screen that looks broken.
```

**Check a flow on iOS**
```text
Allocate an iPhone running iOS 18 or newer, install ./build/MyApp.ipa, sign up with a new
test email, and confirm the profile screen shows the email. Release the device afterwards.
```

**Fill a form on a local simulator**
```text
On the booted iOS simulator, open Settings, search for "Wi-Fi" and tell me which network
is connected.
```

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for how to build, test, and open a pull request, and browse [open issues](https://github.com/TOMOSIA-VIETNAM/device-farm-mcp/issues). Please also review our [Code of Conduct](CODE_OF_CONDUCT.md).

## Acknowledgements

Device Farm MCP builds on [mobile-mcp](https://github.com/mobile-next/mobile-mcp) and [mobilecli](https://github.com/mobile-next/mobilecli) by [Mobile Next](https://github.com/mobile-next), licensed under Apache-2.0.

## Privacy

The server runs on your machine (or your host in HTTP mode). It talks to your local devices and, for remote devices, to AWS Device Farm with your credentials. Apps you install on a remote device are uploaded to your Device Farm project. Anonymous usage telemetry is sent unless `MOBILEMCP_DISABLE_TELEMETRY=1` is set; see the Mobile Next privacy policy at https://mobilenext.ai/privacy.
