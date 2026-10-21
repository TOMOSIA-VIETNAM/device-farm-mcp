# Device Farm MCP - AWS Device Farm とローカルデバイスで iOS・Android を自動操作する MCP サーバー

[English](README.md) | **日本語** | [简体中文](README.zh-CN.md)

Device Farm MCP は、AI エージェントがプラットフォームに依存しない共通のツールで iOS と Android のデバイスを操作できるようにする MCP サーバーです。対象は次のとおりです。

- **[AWS Device Farm](https://aws.amazon.com/device-farm/) の実機**: リモートアクセスセッションとして必要なときに確保し、セッションのマネージド Appium エンドポイント経由で操作します。
- **手元のマシンのデバイス**: iOS シミュレーター、Android エミュレーター、USB 接続した実機。

エージェントは構造化されたアクセシビリティスナップショットを通じてアプリを操作し、必要な場合のみスクリーンショットに基づく座標タップにフォールバックします。

**Claude Code、Codex、Gemini、GitHub Copilot、Cursor** など、MCP 対応のクライアントであれば利用できます。

<h4 align="center">
  <a href="https://www.npmjs.com/package/@tomosia/device-farm-mcp">
    <img src="https://img.shields.io/npm/v/@tomosia/device-farm-mcp?logo=npm&style=flat&color=red" alt="npm" />
  </a>
  <a href="https://github.com/TOMOSIA-VIETNAM/device-farm-mcp/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/TOMOSIA-VIETNAM/device-farm-mcp" alt="license" />
  </a>
</h4>

> Device Farm MCP は [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) のフォークです。リモートデバイスは Mobile Next Cloud ではなく AWS Device Farm から提供されます。ローカルデバイスのサポートは変わりません。

## 目次

- [仕組み](#仕組み)
- [前提条件](#前提条件)
- [AWS Device Farm のセットアップ](#aws-device-farm-のセットアップ)
- [MCP サーバーのインストール](#mcp-サーバーのインストール)
- [動作確認](#動作確認)
- [リモートデバイスの使い方](#リモートデバイスの使い方)
- [利用可能な MCP ツール](#利用可能な-mcp-ツール)
- [ローカルデバイス](#ローカルデバイス)
- [Streamable HTTP サーバーモード](#streamable-http-サーバーモード)
- [環境変数](#環境変数)
- [プロンプト例](#プロンプト例)

## 仕組み

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

1. `mobile_list_remote_devices` が、リモートアクセスに対応した Device Farm のデバイスを一覧表示します。
2. `mobile_allocate_remote_device` が Device Farm プロジェクト内でリモートアクセスセッションを開始します。返される **セッション ARN** が、他のすべての `mobile_*` ツールで使うデバイス ID になります。
3. そのデバイスへのコマンドはすべてセッションの Appium エンドポイントに送られます。
4. `mobile_release_remote_device` がセッションを停止し、課金も止まります。

認証には AWS の標準の認証情報チェーンを使うため、別途ログインする手順はありません。

## 前提条件

- [Node.js](https://nodejs.org/en/download/) v20 以上
- AWS Device Farm を利用できる AWS アカウント。Device Farm は **`us-west-2`** でのみ提供されており、サーバーは常にこのリージョンを使います。
- サーバーを実行するマシン上の AWS 認証情報（後述）
- MCP 対応のクライアントまたはエージェント

ローカルデバイスを使う場合は、[Xcode コマンドラインツール](https://developer.apple.com/xcode/resources/)（iOS）や [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools)（Android）も必要です。

## AWS Device Farm のセットアップ

### 1. IAM 権限を付与する

サーバーを実行する IAM ユーザーまたはロールには、次の Device Farm アクションが必要です。

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

同じ ID で AWS CLI からプロジェクトも管理する場合は、`devicefarm:ListProjects` と `devicefarm:CreateProject` も追加してください。

### 2. AWS 認証情報を設定する

AWS SDK がサポートする方法であれば、どれでも使えます。

- 環境変数: `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`（一時的な認証情報の場合は `AWS_SESSION_TOKEN` も）
- `~/.aws/credentials` / `~/.aws/config` のプロファイル（`AWS_PROFILE` で選択）
- AWS IAM Identity Center: `aws sso login --profile <profile>`

その ID で Device Farm にアクセスできるか確認します。

```bash
aws devicefarm list-devices --region us-west-2 --query 'length(devices)'
```

### 3. Device Farm プロジェクトを作成または選択する

リモートアクセスセッションとアプリのアップロードはプロジェクトに属します。既存のプロジェクトを一覧表示するか、新しく作成します。

```bash
aws devicefarm list-projects --region us-west-2 --query 'projects[].[name,arn]' --output table
aws devicefarm create-project --name device-farm-mcp --region us-west-2 --query 'project.arn' --output text
```

プロジェクト ARN をコピーしておきます。MCP サーバーの設定で `DEVICEFARM_PROJECT_ARN` に指定します。

## MCP サーバーのインストール

ほとんどのクライアントで使える**標準設定**:

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

- `DEVICEFARM_PROJECT_ARN` はデバイスの確保とアプリのインストールに必要です。リモートデバイスの一覧表示とローカルデバイスの利用には不要です。
- `AWS_PROFILE` は任意です。省略するとデフォルトの認証情報チェーンを使います。`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` に置き換えることもできます。
- MCP クライアントはシェルの環境変数を引き継がずにサーバーを起動することが多いため、AWS 関連の変数はシェルプロファイルの `export` に頼らず `env` に設定してください。

**ローカルのチェックアウトから実行する場合**（変更のテストや、リリース公開前の利用）:

```bash
git clone https://github.com/TOMOSIA-VIETNAM/device-farm-mcp.git
cd device-farm-mcp
npm install && npm run build
```

`npx` の代わりに `node` で `lib/index.js` を指定します。

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

### クライアント別の設定

以下のどの例でも、標準設定の `env` の値を追加してください。

<details>
<summary>Claude Code</summary>

Claude Code CLI でサーバーを追加します。

```bash
claude mcp add device-farm-mcp \
  -e DEVICEFARM_PROJECT_ARN=arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234 \
  -e AWS_PROFILE=default \
  -- npx -y @tomosia/device-farm-mcp@latest
```

または Claude Code 内からプラグインをインストールします。MCP サーバーと `/mobile-mirror` が追加されます。

```
/plugin marketplace add TOMOSIA-VIETNAM/device-farm-mcp
/plugin install device-farm-mcp@device-farm-mcp
```

プラグインは `DEVICEFARM_PROJECT_ARN` なしでサーバーを起動するため、リモートデバイスを使う場合は Claude Code を起動する環境でこの変数（および必要な AWS 変数）を設定してください。

`/mobile-mirror [device-id]` を実行すると、デバイスのライブ画面がペインに表示されます。画像をクリックするとタップ、キー入力で文字を送信でき、上部の Home、Back、App Switch、URL ボタンも使えます。kitty や Ghostty など、kitty graphics protocol に対応したターミナルが必要です。

</details>

<details>
<summary>Claude Desktop</summary>

[MCP インストールガイド](https://modelcontextprotocol.io/quickstart/user)に従い、上記の標準設定を使ってください。

</details>

<details>
<summary>Codex</summary>

```bash
codex mcp add device-farm-mcp \
  --env DEVICEFARM_PROJECT_ARN=arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234 \
  -- npx -y @tomosia/device-farm-mcp@latest
```

または `~/.codex/config.toml` を編集します。

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

Copilot CLI 内で `/mcp add` を実行するか、`~/.copilot/mcp-config.json` を編集します。

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

`Cursor Settings` -> `MCP` -> `Add new MCP Server` から追加するか、標準設定を `~/.cursor/mcp.json`（グローバル）または `.cursor/mcp.json`（プロジェクト）に追加します。

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

`.vscode/mcp.json` に追加します。

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

標準設定をクライアントの MCP 設定に追加してください。コマンドを 1 つだけ指定するクライアントでは `npx -y @tomosia/device-farm-mcp@latest` を使い、クライアントの環境変数設定で `DEVICEFARM_PROJECT_ARN` を指定します。

</details>

## 動作確認

エージェントに次のように依頼します。

```text
利用できるリモートデバイスを表示して
```

名前、プラットフォーム、OS バージョン、空き状況を含む Device Farm のデバイス一覧が返ってくれば成功です。認証情報のエラーが出た場合は、[AWS Device Farm のセットアップ](#aws-device-farm-のセットアップ)の手順を確認してください。

ローカルデバイスの場合は「利用可能なデバイスを一覧表示して」と依頼します。起動中のシミュレーター、エミュレーター、接続済みのデバイスが返ります。

## リモートデバイスの使い方

典型的なセッションの例:

```text
Device Farm から Android 14 以上の Android デバイスを確保し、準備ができるまで待ってから
./build/app-release.apk をインストールして、アプリを開きテストアカウントでログインして。
終わったらデバイスを解放して。
```

内部では次の処理が行われます。

| ステップ | ツール | 備考 |
|---|---|---|
| デバイスを探す | `mobile_list_remote_devices` | リモートアクセスが有効なデバイスのみ表示されます。 |
| 確保する | `mobile_allocate_remote_device` | `platform`（必須）、`name`（完全一致、または末尾 `*` で前方一致。例: `Google Pixel*`）、`version`（例: `">=14"`、`"18.6.2"`）で絞り込めます。`wait: true` を指定すると、セッションが実行中になるまで最大 `timeoutSeconds`（デフォルト 900）待機します。空き状況が良いデバイスが優先されます。 |
| アプリをインストールする | `mobile_install_app` | ローカルのファイルをプロジェクトにアップロードし、Device Farm の処理完了を待ってからセッションにインストールします。Android は `.apk`、iOS は `.ipa` のみ対応です。 |
| アプリを操作する | その他の `mobile_*` ツール | `device` にセッション ARN を渡します。 |
| 解放する | `mobile_release_remote_device` | セッションと課金を停止します。インストールしたアプリやデバイスの状態は消去されます。 |

### 料金と制限

- セッション実行中、Device Farm は**デバイス分単位で課金**します。エージェントはデバイスを確保する前に確認を求め、タスク完了後に解放するよう指示されていますが、AWS の請求を確認し、不要になったセッションは解放してください。
- セッションは **150 分**経過するか、**5 分間コマンドがない**と自動的に終了します。
- セッションは AWS コンソールの **Device Farm → Projects → Remote access** で確認・停止できます。CLI の場合:
  ```bash
  aws devicefarm list-remote-access-sessions --region us-west-2 --arn <project-arn>
  aws devicefarm stop-remote-access-session --region us-west-2 --arn <session-arn>
  ```

### リモートデバイスの制限事項

リモートデバイスは Appium 経由で操作するため、一部のツールはローカルデバイスでのみ動作します。

- 画面録画、デバイスログ、クラッシュレポート
- GPS 位置の上書き、クリップボード、折りたたみ
- 要素の `ref` によるタップ（代わりに `mobile_list_elements_on_screen` の座標を使ってください）
- ロケールを指定したアプリの起動

## 利用可能な MCP ツール

### デバイス管理
- **`mobile_list_available_devices`** - ローカルデバイス（シミュレーター、エミュレーター、実機）を一覧表示
- **`mobile_get_screen_size`** - デバイスの画面サイズをピクセル単位で取得
- **`mobile_get_orientation`** - 現在の画面の向きを取得
- **`mobile_set_orientation`** - 画面の向きを変更（縦/横）
- **`mobile_fold_device`** - 折りたたみ式デバイスを折りたたむ/開く（ローカルのみ）
- **`mobile_set_location`** - デバイスが報告する GPS 位置を上書き、または上書きを解除（ローカルのみ）
- **`mobile_clipboard`** - デバイスのクリップボードを読み取り/置き換え（ローカルのみ）

### リモートデバイス（AWS Device Farm）
- **`mobile_list_remote_devices`** - リモートアクセスに対応した AWS Device Farm のデバイスを一覧表示
- **`mobile_allocate_remote_device`** - 条件に合うデバイスでリモートアクセスセッションを開始。セッション ARN が他のツールで使うデバイス ID になります
- **`mobile_release_remote_device`** - リモートアクセスセッションを停止

### アプリ管理
- **`mobile_list_apps`** - インストール済みアプリを一覧表示
- **`mobile_get_foreground_app`** - フォアグラウンドのアプリを取得
- **`mobile_launch_app`** - パッケージ名またはバンドル ID でアプリを起動
- **`mobile_terminate_app`** - 実行中のアプリを終了
- **`mobile_install_app`** - ファイルからアプリをインストール（ローカルは .apk、.ipa、.app、.zip、Device Farm は .apk / .ipa）
- **`mobile_uninstall_app`** - パッケージ名またはバンドル ID でアプリをアンインストール

### 画面操作
- **`mobile_take_screenshot`** - 画面の内容を把握するためにスクリーンショットを撮影
- **`mobile_save_screenshot`** - スクリーンショットをファイルに保存
- **`mobile_list_elements_on_screen`** - UI 要素を座標とプロパティ付きで一覧表示
- **`mobile_click_on_screen_at_coordinates`** - x,y 座標、または ref で指定した要素をクリック
- **`mobile_double_tap_on_screen`** - 座標、または ref で指定した要素をダブルタップ
- **`mobile_long_press_on_screen_at_coordinates`** - 座標、または ref で指定した要素を長押し
- **`mobile_swipe_on_screen`** - 任意の方向にスワイプ
- **`mobile_start_screen_recording`** - 画面の録画を開始（ローカルのみ）
- **`mobile_stop_screen_recording`** - 録画を停止して動画を保存（ローカルのみ）

### 入力とナビゲーション
- **`mobile_type_keys`** - フォーカス中の要素にテキストを入力（送信も可能）
- **`mobile_press_button`** - デバイスのボタンを押す（HOME、BACK、VOLUME_UP/DOWN、ENTER など）
- **`mobile_open_url`** - デバイスのブラウザで http/https の URL を開く

### ログとクラッシュレポート（ローカルのみ）
- **`mobile_get_device_logs`** - デバイスのライブログを収集（Android は logcat、iOS は unified log）。ファイルへの保存も可能
- **`mobile_list_crashes`** - デバイス上のクラッシュレポートを一覧表示
- **`mobile_get_crash`** - ID を指定してクラッシュレポートの全内容を取得

### バッチ実行
- **`mobile_batch_commands`** - 複数のツールを 1 回の呼び出しで順に実行（例: クリック、入力、クリック）。最後に画面の要素を一覧表示することも可能

## ローカルデバイス

ローカルデバイスは [mobilecli](https://github.com/mobile-next/mobilecli) で操作し、AWS の設定は不要です。

| 対象 | セットアップ |
|---|---|
| iOS シミュレーター | Xcode と起動済みのシミュレーター（`xcrun simctl boot "iPhone 16"`） |
| iOS 実機 | USB で接続し、信頼済みであること |
| Android エミュレーター | Android SDK と起動中のエミュレーター（`adb devices`） |
| Android 実機 | `adb` と、有効化・承認済みの USB デバッグ |

ローカルデバイスがない場合、エージェントは代わりに Device Farm のデバイスを提案し、確保する前に確認を求めます。

## Streamable HTTP サーバーモード

サーバーはデフォルトで stdio で動作します。代わりに [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) サーバーとして起動するには `--listen` を使います。

```bash
npx @tomosia/device-farm-mcp@latest --listen 3000          # localhost:3000 にバインド
npx @tomosia/device-farm-mcp@latest --listen 0.0.0.0:3000  # すべてのインターフェースにバインド
```

クライアントは `http://<host>:3000/mcp` に接続します。エンドポイントはステートレスなので、セッションアフィニティなしでロードバランサーの背後で動作します。localhost にバインドした場合、Host ヘッダーによる DNS リバインディング保護が自動で有効になります。

サーバーは実行しているホストの AWS 認証情報を使うため、サーバーに到達できる人は誰でもそのアカウントで Device Farm のデバイスを確保できます。localhost 以外に公開する場合は、`DEVICE_FARM_MCP_AUTH` で Bearer トークンを必須にしてください。

```bash
DEVICE_FARM_MCP_AUTH=my-secret-token npx @tomosia/device-farm-mcp@latest --listen 0.0.0.0:3000
```

設定すると、すべてのリクエストに `Authorization: Bearer my-secret-token` ヘッダーが必要になります。`DEVICE_FARM_MCP_AUTH` を設定しない場合、サーバーは認証なしの接続を受け付け、警告をログに出力します。

## 環境変数

| 変数 | 説明 | 例 |
|---|---|---|
| `DEVICEFARM_PROJECT_ARN` | リモートアクセスセッションとアプリのアップロードに使う AWS Device Farm プロジェクト。 | `arn:aws:devicefarm:us-west-2:111122223333:project:abcd-1234` |
| `AWS_PROFILE`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN` | AWS SDK 標準の認証情報。デフォルトの認証情報チェーンの他の方法も使えます。 | `AWS_PROFILE=devicefarm` |
| `DEVICE_FARM_MCP_AUTH` | Streamable HTTP サーバー（`--listen`）で Bearer トークンを必須にします。 | `my-secret-token` |
| `DEVICE_FARM_MCP_DISABLE_TELEMETRY` | 匿名の利用状況テレメトリ（PostHog と Scarf）を無効にします。 | `1` |
| `DEVICE_FARM_MCP_ALLOW_UNSAFE_URLS` | `mobile_open_url` で標準以外の URL スキームを開けるようにします（デフォルトではブロック）。 | `1` |
| `DEVICE_FARM_MCP_LEGACY_ROBOT` | ローカルの Android デバイスと iOS 実機で、従来のプラットフォーム別ロボットを使います。iOS シミュレーターは引き続き `mobilecli` を使います。 | `1` |

## プロンプト例

具体的かつ簡潔に書いてください。適切なツールはエージェントが選びます。

**複数デバイスでビルドのスモークテスト**
```text
Device Farm の "Google Pixel 8" と "Samsung Galaxy S24" それぞれについて、デバイスを確保し、
./build/app-release.apk をインストールしてアプリを起動し、オンボーディングを進めてホーム画面の
スクリーンショットを撮り、デバイスを解放して。表示が崩れている画面があれば報告して。
```

**iOS でフローを確認**
```text
iOS 18 以上の iPhone を確保して ./build/MyApp.ipa をインストールし、新しいテスト用メールアドレスで
サインアップして、プロフィール画面にそのメールアドレスが表示されることを確認して。終わったらデバイスを解放して。
```

**ローカルのシミュレーターで操作**
```text
起動中の iOS シミュレーターで設定を開き、「Wi-Fi」を検索して、接続中のネットワークを教えて。
```

## コントリビューション

コントリビューションを歓迎します。ビルド、テスト、プルリクエストの作成方法は [CONTRIBUTING.md](CONTRIBUTING.md) を参照し、[オープンな issue](https://github.com/TOMOSIA-VIETNAM/device-farm-mcp/issues) も確認してください。[行動規範](CODE_OF_CONDUCT.md)もあわせてご確認ください。

## 謝辞

Device Farm MCP は、[Mobile Next](https://github.com/mobile-next) による [mobile-mcp](https://github.com/mobile-next/mobile-mcp) と [mobilecli](https://github.com/mobile-next/mobilecli)（Apache-2.0 ライセンス）をベースにしています。

## プライバシー

サーバーは手元のマシン（HTTP モードの場合はそのホスト）で動作します。ローカルデバイスと通信し、リモートデバイスについてはあなたの認証情報で AWS Device Farm と通信します。リモートデバイスにインストールするアプリは、あなたの Device Farm プロジェクトにアップロードされます。`DEVICE_FARM_MCP_DISABLE_TELEMETRY=1` を設定しない限り、匿名の利用状況テレメトリが送信されます。詳しくは Mobile Next のプライバシーポリシー https://mobilenext.ai/privacy を参照してください。
