/**
 * ==============================================================
 * 遷移先ページ スクリーンショット取得スクリプト (Playwright)
 * ==============================================================
 *
 * 目的:
 *   Google Ads APIから取得した遷移先URL(パフォーマンス履歴に記録済み)のうち、
 *   まだ撮影していないものについて、実際のページを開いてスクリーンショットを撮り、
 *   GAS Web App経由でDriveに格納する。
 *
 * 全体フロー:
 *   1. GAS Web Appに「撮影すべきURL一覧をください」とGETリクエスト
 *   2. 各URLについて、ページを開いてフルページのスクリーンショットを撮影
 *   3. 画像をbase64化し、GAS Web AppへPOST（Drive保存・ログ記録はGAS側で行う）
 *
 * 前提:
 *   画像取得・CSV取得と同じ環境変数（GAS_WEBAPP_URL, GAS_SHARED_SECRET）を使う。
 *   ログインセッション(auth.json)は不要（遷移先の記事ページは通常ログイン不要のため）。
 *
 * 実行:
 *   node capture_landing_page_screenshots.js
 * ==============================================================
 */

const { chromium } = require('playwright');

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const GAS_SHARED_SECRET = process.env.GAS_SHARED_SECRET || '';

if (!GAS_WEBAPP_URL) {
  console.error('環境変数 GAS_WEBAPP_URL が設定されていません。');
  process.exit(1);
}

/** GASから撮影対象のURL一覧を取得する */
async function fetchPendingUrls() {
  const url = `${GAS_WEBAPP_URL}?secret=${encodeURIComponent(GAS_SHARED_SECRET)}&action=pendingScreenshotUrls`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== 'success') {
    throw new Error(`撮影対象URL取得失敗: ${json.message}`);
  }
  return json.urls || [];
}

/** 撮影結果をGAS Web AppにPOSTする */
async function uploadScreenshotToGas(targetUrl, base64) {
  const res = await fetch(GAS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: GAS_SHARED_SECRET,
      type: 'screenshotResult',
      url: targetUrl,
      imageBase64: base64,
      mimeType: 'image/jpeg',
    }),
  });
  return await res.json();
}

/** ページ末尾まで少しずつスクロールし、遅延読み込み(lazy load)の画像等を読み込ませる */
async function autoScrollToBottom(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
  // スクロール完了後、直近で発火した遅延読み込みが完了するまで少し待つ
  await page.waitForTimeout(1000);
}

async function main() {
  const pendingUrls = await fetchPendingUrls();
  console.log(`撮影対象URL: ${pendingUrls.length} 件`);

  if (pendingUrls.length === 0) {
    console.log('撮影対象がありません。終了します。');
    return;
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  let succeeded = 0;
  let failed = 0;

  for (const targetUrl of pendingUrls) {
    console.log(`\n=== ${targetUrl} ===`);
    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await autoScrollToBottom(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500); // スクロール後、先頭表示が安定するまで少し待つ

      const buffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 70 });
      const base64 = buffer.toString('base64');

      const result = await uploadScreenshotToGas(targetUrl, base64);
      if (result.status === 'success') {
        console.log('  ✓ 撮影・保存完了');
        succeeded++;
      } else {
        console.warn(`  ✗ 保存失敗: ${result.message}`);
        failed++;
      }
    } catch (err) {
      console.error(`  ✗ 撮影失敗: ${err.message}`);
      failed++;
    }
  }

  await browser.close();
  console.log(`\n完了: 成功 ${succeeded} 件 / 失敗 ${failed} 件`);
}

main().catch((err) => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
