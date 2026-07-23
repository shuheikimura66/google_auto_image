# デマンドジェネレーション画像 自動格納の仕組み セットアップ手順

## 全体像

```
[スプレッドシート「アカウント管理」]
        │ (稼働中のみ抽出)
        ▼
   GAS Web App ── doGet ──▶ 対象アカウント一覧をJSONで返す
        ▲
        │ POST (画像データ)
[Playwright] ── 各アカウントのアセットレポート画面を直接開く
              ── スクロールしながら画像URL・ファイル名を収集
              ── 画像を直接fetch(認証不要)
              ── GAS Web AppにPOST
        │
        ▼
   GAS Web App ── CIDごとのDriveサブフォルダに保存 + 重複ログ管理
```

## 重要な注意点: CID と ocid は別物です

Google Ads管理画面のURLに使われる `ocid` は、表示用のCID(例: `114-437-3197`)とは異なる内部ID(例: `7080750168`)です。ハイフンを外すだけでは`ocid`になりません。

**運用開始前に、対象アカウントごとに1回だけ実際のocidを控えて、スプレッドシートに列を追加してください。**

調べ方: 対象アカウントを開いた状態で管理画面のURLを見ると `ocid=XXXXXXXXXX` が含まれています。これを「アカウント管理」シートの新しい列(例: E列)に記録し、`GAS_Code.gs` の `doGet` でこの列も返すようにし、`scrape_demandgen_images.js` の `buildAssetReportUrl` で `account.ocid` を使うようにしてください(コード側は `account.ocid` を優先的に使う実装に既になっています。シート側にocid列を追加し、doGet側の返却オブジェクトに `ocid` を含めるだけで動きます)。

## 1. スプレッドシート準備

シート名「アカウント管理」を作成し、以下の列を用意:

| 列 | 内容 |
|---|---|
| A | CID (表示用、例: 114-437-3197) |
| B | アカウント名 |
| C | ステータス(「稼働中」の行のみ処理対象) |
| D | 親Driveフォルダ(URLまたはフォルダID) |
| E | (推奨) ocid ※上記注意点を参照 |

「取得ログ」シートはGASが自動作成するので、事前準備不要です。

## 2. GAS Web Appのデプロイ

1. 対象のスプレッドシートを開き、「拡張機能」→「Apps Script」
2. `GAS_Code.gs` の内容を貼り付け
3. スクリプトプロパティに `SHARED_SECRET` を設定(任意の文字列。簡易的な認証トークンとして使用)
   - 「プロジェクトの設定」→「スクリプト プロパティ」→ 追加
4. 「デプロイ」→「新しいデプロイ」→ 種類:ウェブアプリ
   - 実行するユーザー: 自分
   - アクセスできるユーザー: 自分のみ(推奨) または リンクを知っている全員
5. 発行されたウェブアプリURLを控える

## 3. Playwright側のセットアップ

```bash
npm install playwright
npx playwright install chromium
```

### ログインセッションの保存(初回のみ、手動)

```bash
npx playwright open https://ads.google.com --save-storage=auth.json
```

ブラウザが開くのでログインし、対象アカウントが見える状態になったらウィンドウを閉じてください。`auth.json` にセッションが保存されます。

### 環境変数の設定

```bash
export GAS_WEBAPP_URL="https://script.google.com/macros/s/xxxxx/exec"
export GAS_SHARED_SECRET="上で設定した文字列"
export STORAGE_STATE_PATH="auth.json"
```

### 実行

```bash
node scrape_demandgen_images.js
```

## 4. GitHub Actionsへの移行時の注意

- `auth.json` はログインセッション(Cookie)そのものなので、**リポジトリに直接コミットしない**。GitHub Secretsにbase64化して格納し、ワークフロー内でファイルに復元する運用にしてください。
- Cookieには有効期限があるため、定期的に手動で再ログイン→`auth.json`を再生成→Secrets更新、という運用が必要になります。
- `GAS_SHARED_SECRET` もGitHub Secretsに格納してください。

## 5. 今後の拡張ポイント

- 現状は画像(ロゴ・正方形・横長)をすべて対象にしていますが、`asset.filename` 抽出のフィルタ条件を絞ることで特定の種別のみに限定可能です。
- 実行時間が長くなる場合(アカウント数・画像数が多い場合)、GitHub Actions側でアカウントを分割して並列実行することも可能です。
