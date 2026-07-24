/**
 * ==============================================================
 * アセット パフォーマンス レポート エクスポート スクリプト (Playwright)
 * ==============================================================
 *
 * 目的:
 *   各バナー画像・テキストが、どのような効果(費用・クリック率・コンバージョン等)を
 *   上げているかを、後からClaudeに読み込ませて分析するためのデータを自動取得する。
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
 *      （Google Adsのcsv出力はUTF-16LEのため、Node.js側でBufferを
 *        明示的にutf16leとしてデコードしてから送信し、文字化け問題を解消）
 *   6. GAS Web Appに正しくデコード済みのCSVテキストをPOSTし、
 *      Drive内の {CID}/reports/ フォルダへ格納
 *      （同日再実行時は上書き、ログはGAS側の「レポート取得ログ」シートで管理）
 *   7. 各アカウントの処理完了後、成功/エラーをGASへ報告し、
 *      「アカウント管理」シートのH列(CSV格納)を更新する
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

/**
 * role + 候補名(複数)を順番に試し、最初に見つかったものをクリックする。
 * UI言語が日本語/英語のどちらでレンダリングされても対応できるようにするためのヘルパー。
 * names には文字列または正規表現を混在させて渡せる。
 */
async function clickByAnyName(page, role, names, options = {}) {
  const tried = [];
  for (const name of names) {
    tried.push(name.toString());
    const locator = page.getByRole(role, { name, ...options });
    try {
      await locator.first().waitFor({ state: 'visible', timeout: 5000 });
      await locator.first().click();
      return name;
    } catch (err) {
      // このnameでは見つからなかったので次の候補を試す
    }
  }
  throw new Error(`要素が見つかりませんでした (role: ${role}, 試した名前: ${tried.join(' / ')})`);
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

/** 期間セレクタを開き、「今月」/「This month」を選択して適用する（日英どちらのUIでも対応） */
async function setDateRangeToThisMonth(page) {
  // 日付範囲ボタンのテキストは動的（現在の期間表示）なので、
  // 日本語形式(2026年7月1日〜)・英語形式(Jul 1, 2026〜)の両方にマッチする正規表現を用意
  const dateRangeButtonNamePatterns = [
    /^\d{4}年\d{1,2}月\d{1,2}日/, // 例: 2026年7月1日〜23日
    /^[A-Za-z]{3,9}\.?\s\d{1,2}/, // 例: Jul 1 – 23, 2026 / July 1 - 23, 2026
  ];
  await clickByAnyName(page, 'button', dateRangeButtonNamePatterns);

  await clickByAnyName(page, 'menuitemradio', ['今月', 'This month']);

  // 「適用」ボタンは、選択によって期間が実際に変化した場合のみ表示されることがある。
  // 既に「今月」が選択済み（変化なし）の場合はボタンが出ずにそのまま閉じることがあるため、
  // 見つからなくてもエラーにせず続行する。
  try {
    await clickByAnyName(page, 'button', ['適用', 'Apply']);
  } catch (err) {
    console.log('  ⚠ 「適用」ボタンが見つかりませんでした（既に今月が選択済みだった可能性）。そのまま続行します。');
    // 万一メニューが開いたままの場合に備えて閉じておく
    await page.keyboard.press('Escape').catch(() => {});
  }

  // 反映待ち
  await page.waitForTimeout(1000);
}

/**
 * 「表示項目」ドロワーを開き、すべての列カテゴリを展開したうえで、
 * 「表示項目の設定を保存する」以外の未チェック項目を全てONにして適用する。
 */
async function enableAllColumns(page) {
  await clickByAnyName(page, 'button', ['表示項目', 'Columns']);
  await page.waitForTimeout(500);

  // 全カテゴリパネルを展開（言語非依存: aria-expanded属性で判定）
  await page.evaluate(async () => {
    const headers = Array.from(document.querySelectorAll('material-expansionpanel .header'));
    for (const h of headers) {
      if (h.getAttribute('aria-expanded') === 'false') {
        h.click();
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });

  // 未チェックのチェックボックスを全てON（言語非依存: クラス名・aria-checkedで判定。
  // 「設定を保存する」チェックボックスは除外）
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

  try {
    await clickByAnyName(page, 'button', ['適用', 'Apply']);
  } catch (err) {
    console.log('  ⚠ 「適用」ボタンが見つかりませんでした（既に全項目ON済みだった可能性）。そのまま続行します。');
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(1000);
}

/** 「ダウンロード」→「Excel .csv」でCSVをエクスポートし、ローカルに保存してパスを返す */
async function downloadCsv(page, cid) {
  await clickByAnyName(page, 'button', ['ダウンロード', 'Download']);

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

/**
 * GAS Web AppにCSVの中身（正しくデコード済みのテキスト）をPOSTしてDriveへ保存。
 * Google AdsのExcel .csvはUTF-16LE（先頭にBOM付き）で出力されるため、
 * Node.jsのBufferで明示的にutf16leとしてデコードしてから送る。
 * これによりGAS側は普通のUTF-8テキストとして受け取れる。
 */
async function uploadCsvToGas(cid, filename, csvText) {
  const res = await fetch(GAS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: GAS_SHARED_SECRET,
      type: 'reportCsv',
      cid,
      filename,
      csvText,
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

    // Google AdsのCSVはUTF-16LE（BOM付き）で出力されるため、明示的にデコードする
    const buffer = fs.readFileSync(localPath);
    let csvText = buffer.toString('utf16le');
    // 先頭のBOM文字（U+FEFF）が残っていれば取り除く
    if (csvText.charCodeAt(0) === 0xFEFF) {
      csvText = csvText.slice(1);
    }

    const filename = `${account.cid}_${dateStr}.csv`;
    const result = await uploadCsvToGas(account.cid, filename, csvText);

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
    locale: 'ja-JP',
    extraHTTPHeaders: {
      'Accept-Language': 'ja-JP,ja;q=0.9',
    },
    viewport: { width: 1600, height: 900 },
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
