/**
 * ==============================================================
 * アセット パフォーマンス レポート CSVエクスポート スクリプト (Playwright)
 * ==============================================================
 *
 * 目的:
 *   各バナー画像・テキストが、どのような効果(費用・クリック率・コンバージョン等)を
 *   上げているかを、後からClaudeに読み込ませて分析するためのCSVを自動取得する。
 *   scrape_demandgen_images.js（画像そのものの格納）とは別の、独立したワークフロー。
 *
 * 全体フロー（アカウントごと）:
 *   1. GAS Web App から「稼働中」アカウント一覧 (CID + 親Driveフォルダ) を取得
 *   2. 各CIDについて、MCCを経由せず直接
 *        https://ads.google.com/aw/assetreport/performance?ocid={CID}&ascid={CID}
 *      へ遷移（タイムアウト時は1回リトライ）
 *   3. 期間を「今月」に変更
 *   4. 表示項目(列)をすべてON
 *   5. 「ダウンロード」→「Excel .csv」でCSVをエクスポート
 *   6. GAS Web App にCSVをPOSTし、Drive内の {CID}/reports/ フォルダへ格納
 *      （同日再実行時は上書き、ログはGAS側の「レポート取得ログ」シートで管理）
 *   7. 各アカウントの処理完了後、成功/エラーをGASへ報告し、
 *      「アカウント管理」シートのF列(最終稼働日)・G列(稼働状況)を更新する
 *
 * 前提:
 *   - scrape_demandgen_images.js と同じ auth.json（ログインセッション）を使い回せる
 *   - 環境変数 GAS_WEBAPP_URL, GAS_SHARED_SECRET, STORAGE_STATE_PATH は共通
 *
 * 実行:
 *   node export_asset_reports.js
 * ==============================================================
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const GAS_SHARED_SECRET = process.env.GAS_SHARED_SECRET || '';
const STORAGE_STATE_PATH = process.env.STORAGE_STATE_PATH || 'auth.json';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || 'downloads';

if (!GAS_WEBAPP_URL) {
  console.error('環境変数 GAS_WEBAPP_URL が設定されていません。');
  process.exit(1);
}

/** GASから稼働中アカウント一覧を取得 */
async function fetchActiveAccounts() {
  const url = `${GAS_WEBAPP_URL}?secret=${encodeURIComponent(GAS_SHARED_SECRET)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'success') {
    throw new Error(`アカウント一覧の取得に失敗: ${data.message}`);
  }
  return data.accounts; // [{cid, name, parentFolder, ocid}, ...]
}

function buildAssetReportUrl(account) {
  const ocid = account.ocid || account.cid.replace(/-/g, '');
  return `https://ads.google.com/aw/assetreport/performance?ocid=${ocid}&ascid=${ocid}&workspaceId=0`;
}

/** page.gotoをリトライ付きで実行する（scrape_demandgen_images.jsと同仕様） */
async function gotoWithRetry(page, url, options = {}, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(url, options);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`  ⚠ ページ遷移失敗 (試行 ${attempt}/${maxAttempts}): ${err.message}`);
      if (attempt < maxAttempts) {
        await page.waitForTimeout(3000);
      }
    }
  }
  throw lastErr;
}

/** 期間セレクタを開き、「今月」を選択して適用する */
async function setDateRangeToThisMonth(page) {
  const dateRangeButton = page.getByRole('button', { name: /^\d{4}年\d{1,2}月\d{1,2}日/ });
  await dateRangeButton.click();

  const thisMonthOption = page.getByRole('menuitemradio', { name: '今月', exact: true });
  await thisMonthOption.click();

  const applyButton = page.getByRole('button', { name: '適用', exact: true });
  await applyButton.click();

  // 反映待ち
  await page.waitForTimeout(1000);
}

/**
 * 「表示項目」ドロワーを開き、すべての列カテゴリを展開したうえで、
 * 「表示項目の設定を保存する」以外の未チェック項目を全てONにして適用する。
 */
async function enableAllColumns(page) {
  const columnsButton = page.getByRole('button', { name: '表示項目', exact: true });
  await columnsButton.click();
  await page.waitForTimeout(500);

  // 全カテゴリパネルを展開
  await page.evaluate(async () => {
    const headers = Array.from(document.querySelectorAll('material-expansionpanel .header'));
    for (const h of headers) {
      if (h.getAttribute('aria-expanded') === 'false') {
        h.click();
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });

  // 未チェックのチェックボックスを全てON（「設定を保存する」チェックボックスは除外）
  const clickedCount = await page.evaluate(async () => {
    const boxes = Array.from(document.querySelectorAll('material-checkbox'));
    let clicked = 0;
    for (const box of boxes) {
      if (box.classList.contains('save-columns-checkbox')) continue;
      if (box.getAttribute('aria-checked') === 'false') {
        box.click();
        await new Promise((r) => setTimeout(r, 150));
        clicked++;
      }
    }
    return clicked;
  });
  console.log(`  表示項目: 新たに ${clickedCount} 件をONにしました`);

  const applyButton = page.getByRole('button', { name: '適用', exact: true });
  await applyButton.click();
  await page.waitForTimeout(1000);
}

/** 「ダウンロード」→「Excel .csv」でCSVをエクスポートし、ローカルに保存してパスを返す */
async function downloadCsv(page, cid) {
  const downloadButton = page.getByRole('button', { name: 'ダウンロード', exact: true });
  await downloadButton.click();

  const excelCsvOption = page.getByRole('menuitem', { name: 'Excel .csv', exact: true });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    excelCsvOption.click(),
  ]);

  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  const dateStr = formatDateYYYYMMDD(new Date());
  const localPath = path.join(DOWNLOAD_DIR, `${cid}_${dateStr}.csv`);
  await download.saveAs(localPath);
  return { localPath, dateStr };
}

function formatDateYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** GAS Web AppにCSVをPOSTしてDriveへ保存 */
async function uploadCsvToGas(cid, filename, base64) {
  const res = await fetch(GAS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: GAS_SHARED_SECRET,
      type: 'reportCsv',
      cid,
      filename,
      fileBase64: base64,
      mimeType: 'text/csv',
    }),
  });
  return await res.json();
}

/** アカウント単位の実行結果をGASへ報告（「アカウント管理」シートのH列(CSV格納)を更新） */
async function reportAccountStatus(cid, accountStatus, message) {
  try {
    const res = await fetch(GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: GAS_SHARED_SECRET,
        type: 'accountStatus',
        source: 'csvExport',
        cid,
        accountStatus,
        message: message || null,
      }),
    });
    const result = await res.json();
    if (result.status !== 'success') {
      console.warn(`  ⚠ ステータス報告に失敗: ${result.message}`);
    }
  } catch (err) {
    console.warn(`  ⚠ ステータス報告中にエラー: ${err.message}`);
  }
}

async function processAccount(page, account) {
  console.log(`\n=== ${account.name} (${account.cid}) ===`);
  const url = buildAssetReportUrl(account);

  try {
    await gotoWithRetry(page, url, { waitUntil: 'networkidle' });

    await setDateRangeToThisMonth(page);
    console.log('  期間: 今月に設定しました');

    await enableAllColumns(page);

    const { localPath, dateStr } = await downloadCsv(page, account.cid);
    console.log(`  CSVダウンロード完了: ${localPath}`);

    const base64 = fs.readFileSync(localPath).toString('base64');
    const filename = `${account.cid}_${dateStr}.csv`;
    const result = await uploadCsvToGas(account.cid, filename, base64);

    if (result.status === 'success') {
      console.log(`  ✓ Driveへ格納: ${filename}`);
      await reportAccountStatus(account.cid, 'OK', null);
    } else {
      console.warn(`  ✗ Drive格納に失敗: ${result.message}`);
      await reportAccountStatus(account.cid, 'ERROR', `Drive格納失敗: ${result.message}`);
    }

    // ローカルの一時ファイルを削除
    fs.unlinkSync(localPath);
  } catch (err) {
    console.error(`  ✗ エラー: ${err.message}`);
    await reportAccountStatus(account.cid, 'ERROR', err.message);
  }
}

async function main() {
  const accounts = await fetchActiveAccounts();
  console.log(`対象アカウント: ${accounts.length} 件`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
    acceptDownloads: true,
  });
  const page = await context.newPage();

  for (const account of accounts) {
    await processAccount(page, account);
  }

  await browser.close();
}

main().catch((err) => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
