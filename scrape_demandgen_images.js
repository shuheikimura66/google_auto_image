/**
 * ==============================================================
 * デマンドジェネレーション画像 自動取得スクリプト (Playwright)
 * ==============================================================
 *
 * 全体フロー:
 *   1. GAS Web App から「稼働中」アカウント一覧 (CID + 親Driveフォルダ) を取得
 *   2. 各CIDについて、MCCを経由せず直接
 *        https://ads.google.com/aw/assetreport/performance?ocid={CID}&ascid={CID}
 *      へ遷移（タイムアウト等で失敗した場合は1回リトライ）
 *   3. ページを自動スクロールし、仮想スクロールで遅延ロードされる
 *      画像アセット行をすべて収集（ファイル名で重複排除）
 *   4. 各画像URL (tpc.googlesyndication.com/simgad/...) を直接fetchしてダウンロード
 *      （認証不要で取得可能なことを確認済み）
 *   5. GAS Web App に (cid, filename, imageBase64) をPOSTし、
 *      Drive内のCIDサブフォルダへ格納 + 重複ログ管理はGAS側に一任
 *   6. 各アカウントの処理完了後、成功/一部エラー/エラーをGASへ報告し、
 *      「アカウント管理」シートのF列(最終稼働日)・G列(稼働状況)を更新する
 *
 * 前提:
 *   - ログイン状態は storageState (Cookie) を使い回す想定。
 *     初回のみ手動ログインしてstorageStateを保存してください。
 *       npx playwright open https://ads.google.com --save-storage=auth.json
 *   - 環境変数 GAS_WEBAPP_URL, GAS_SHARED_SECRET を設定してください。
 *
 * 実行:
 *   node scrape_demandgen_images.js
 * ==============================================================
 */

const { chromium } = require('playwright');

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const GAS_SHARED_SECRET = process.env.GAS_SHARED_SECRET || '';
const STORAGE_STATE_PATH = process.env.STORAGE_STATE_PATH || 'auth.json';

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
  return data.accounts; // [{cid, name, parentFolder}, ...]
}

/** CID (例: 114-437-3197) から ocid用の数値文字列は使わず、そのままURLパラメータに使う。
 *  Google Ads の ocid はハイフン無しの内部ID (例: 7080750168) だが、
 *  スプレッドシートには表示用CID(114-437-3197)しか無いケースが多いため、
 *  実運用では「アカウント管理」シートに ocid 列を追加しておくのが確実。
 *  ここでは簡便のため、CIDのハイフンを除去した文字列を ascid としても
 *  そのままURLに使えるかを試すフォールバックにしている。
 *  ※ 確実性を優先するなら、事前に各CIDのocidを1回だけ手動で控えてシートに追加してください。
 */
function buildAssetReportUrl(account) {
  const ocid = account.ocid || account.cid.replace(/-/g, '');
  return `https://ads.google.com/aw/assetreport/performance?ocid=${ocid}&ascid=${ocid}&workspaceId=0`;
}

/**
 * ページ内を自動スクロールしながら、画像アセット行を重複なく収集する。
 * ブラウザコンテキスト内で実行するため page.evaluate 経由。
 */
async function collectImageAssets(page) {
  return await page.evaluate(async () => {
    function scrapeCurrent(collected) {
      const imgs = Array.from(document.querySelectorAll('img[alt="asset image"]'));
      imgs.forEach((img) => {
        const row = img.closest('[role="row"]');
        const text = row ? row.innerText : '';
        const fnameMatch = text.match(/([\w\-]+\.(png|jpg|jpeg))/i);
        // ファイル名が取れない場合はURL末尾のIDをフォールバックとして使う
        const filename = fnameMatch ? fnameMatch[1] : `${img.src.split('/').pop()}.png`;
        if (!collected.has(filename)) {
          collected.set(filename, { src: img.src, filename });
        }
      });
    }

    const mainEl = document.querySelector('.main') || document.scrollingElement || document.body;
    const collected = new Map();
    scrapeCurrent(collected);

    let lastScrollTop = -1;
    let stableCount = 0;
    for (let i = 0; i < 100; i++) {
      mainEl.scrollTop += 400;
      await new Promise((r) => setTimeout(r, 350));
      scrapeCurrent(collected);
      if (mainEl.scrollTop === lastScrollTop) {
        stableCount++;
        if (stableCount > 3) break;
      } else {
        stableCount = 0;
      }
      lastScrollTop = mainEl.scrollTop;
    }
    return Array.from(collected.values());
  });
}

/** 表示行数を可能な限り大きくして仮想スクロール量を減らす（存在する場合のみ） */
async function maximizePageSize(page) {
  try {
    const pageSizeButton = page.getByRole('button', { name: /表示する行数/ });
    if (await pageSizeButton.isVisible({ timeout: 3000 })) {
      await pageSizeButton.click();
      const option500 = page.getByRole('option', { name: '500' });
      if (await option500.isVisible({ timeout: 2000 })) {
        await option500.click();
        await page.waitForTimeout(1000);
      } else {
        await page.keyboard.press('Escape');
      }
    }
  } catch (e) {
    // ページサイズ変更UIが見つからなくても処理は継続する
    console.warn('  表示行数の変更をスキップ:', e.message);
  }
}

/** 画像をfetchしてbase64文字列に変換（認証Cookie不要） */
async function downloadImageAsBase64(page, imageUrl) {
  // ブラウザコンテキスト内でfetchすることで、簡易的なUA/ネットワーク経路の一貫性を保つ
  return await page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: 'omit' });
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return {
      base64: btoa(binary),
      mimeType: res.headers.get('content-type') || 'image/png',
    };
  }, imageUrl);
}

/** GAS Web AppにPOSTしてDriveへ保存 */
async function uploadToGas(cid, filename, base64, mimeType) {
  const res = await fetch(GAS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: GAS_SHARED_SECRET,
      cid,
      filename,
      imageBase64: base64,
      mimeType,
    }),
  });
  return await res.json();
}

/**
 * アカウント単位の実行結果をGASへ報告する。
 * GAS側で「アカウント管理」シートのF列(最終稼働日)・G列(稼働状況)を更新する。
 * accountStatus: 'OK' | 'PARTIAL' | 'ERROR'
 */
async function reportAccountStatus(cid, accountStatus, message) {
  try {
    const res = await fetch(GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: GAS_SHARED_SECRET,
        type: 'accountStatus',
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
    // ステータス報告自体の失敗でスクリプト全体を止めたくないので、警告のみ
    console.warn(`  ⚠ ステータス報告中にエラー: ${err.message}`);
  }
}

/**
 * page.gotoをリトライ付きで実行する。
 * 1回目が失敗した場合、少し待ってから2回目を試す（合計最大2回）。
 */
async function gotoWithRetry(page, url, options = {}, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(url, options);
      return; // 成功したら終了
    } catch (err) {
      lastErr = err;
      console.warn(`  ⚠ ページ遷移失敗 (試行 ${attempt}/${maxAttempts}): ${err.message}`);
      if (attempt < maxAttempts) {
        await page.waitForTimeout(3000); // 少し待ってから再試行
      }
    }
  }
  throw lastErr; // 全試行が失敗したら最後のエラーを投げる
}

async function processAccount(page, account) {
  console.log(`\n=== ${account.name} (${account.cid}) ===`);
  const url = buildAssetReportUrl(account);

  try {
    await gotoWithRetry(page, url, { waitUntil: 'networkidle' });
  } catch (gotoErr) {
    // リトライしても失敗した場合はアカウント全体をエラーとして報告
    await reportAccountStatus(account.cid, 'ERROR', `ページ遷移失敗(リトライ後): ${gotoErr.message}`);
    throw gotoErr;
  }

  await maximizePageSize(page);

  const assets = await collectImageAssets(page);
  console.log(`  画像アセット ${assets.length} 件を検出`);

  let errorCount = 0;
  const errorMessages = [];

  for (const asset of assets) {
    try {
      const { base64, mimeType } = await downloadImageAsBase64(page, asset.src);
      const result = await uploadToGas(account.cid, asset.filename, base64, mimeType);
      if (result.status === 'success') {
        console.log(`  ✓ 保存: ${asset.filename}`);
      } else if (result.status === 'skipped') {
        console.log(`  - スキップ(既存): ${asset.filename}`);
      } else {
        console.warn(`  ✗ 失敗: ${asset.filename} -> ${result.message}`);
        errorCount++;
        errorMessages.push(`${asset.filename}: ${result.message}`);
      }
    } catch (err) {
      console.error(`  ✗ エラー: ${asset.filename} ->`, err.message);
      errorCount++;
      errorMessages.push(`${asset.filename}: ${err.message}`);
    }
  }

  // --- アカウント単位の実行結果をGASへ報告 ---
  if (errorCount === 0) {
    await reportAccountStatus(account.cid, 'OK', null);
  } else {
    await reportAccountStatus(
      account.cid,
      'PARTIAL',
      `${errorCount}/${assets.length}件失敗: ${errorMessages.join(' / ')}`
    );
  }
}

async function main() {
  const accounts = await fetchActiveAccounts();
  console.log(`対象アカウント: ${accounts.length} 件`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  const page = await context.newPage();

  for (const account of accounts) {
    try {
      await processAccount(page, account);
    } catch (err) {
      // ここに来る時点でGASへのエラー報告は processAccount 内で完了済み
      console.error(`アカウント処理中にエラー (${account.cid}):`, err.message);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
