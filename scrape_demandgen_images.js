/**
 * ==============================================================
 * デマンドジェネレーション画像 自動格納 GAS Web App
 * ==============================================================
 *
 * 役割:
 *   Playwright側から「CID・ファイル名・画像バイナリ(base64)」をPOSTされたら、
 *   1. アカウント管理シートから該当CIDの親Driveフォルダを取得
 *   2. 親フォルダ配下に「CID」名のサブフォルダを取得 or 新規作成
 *   3. 取得ログシートで (CID + ファイル名) の重複をチェック
 *   4. 未処理であれば画像をサブフォルダに保存
 *   5. 取得ログシートに記録
 *
 *   また、Playwright側からアカウント単位の実行結果 (type: 'accountStatus') が
 *   POSTされた場合は、アカウント管理シートのF・G列（最終稼働日・稼働状況）を更新する。
 *
 * スプレッドシート構成:
 *   シート「アカウント管理」
 *     A列: CID (例: 114-437-3197)
 *     B列: アカウント名
 *     C列: ステータス (「稼働中」のみ対象)
 *     D列: 親Driveフォルダ (URL でも フォルダID でも可)
 *     E列: ocid
 *     F列: 最終稼働日 (Playwright実行時に自動更新)
 *     G列: 稼働状況 ("OK" / "一部エラー: ..." / "エラー: ...")
 *
 *   シート「取得ログ」(なければ自動作成)
 *     A列: CID
 *     B列: ファイル名
 *     C列: DriveファイルID
 *     D列: 取得日時
 *
 * デプロイ:
 *   拡張機能 > Apps Script にこのファイルを貼り付け、
 *   「デプロイ」>「新しいデプロイ」> 種類:ウェブアプリ
 *   実行ユーザー: 自分 / アクセスできるユーザー: 自分のみ（またはリンクを知っている全員）
 *   発行されたURLをPlaywright側の環境変数 (GAS_WEBAPP_URL) に設定してください。
 *
 *   さらに、リクエストの正当性を確認するための簡易トークンを
 *   スクリプトプロパティ「SHARED_SECRET」に設定し、Playwright側から
 *   同じ値をヘッダー等で送る運用を推奨します（本コードでは body.secret で検証）。
 * ==============================================================
 */

const ACCOUNT_SHEET_NAME = 'アカウント管理';
const LOG_SHEET_NAME = '取得ログ';

/**
 * GET: 稼働中アカウント一覧を返す
 * Playwright側はこれを叩いて処理対象CIDのリストを取得する。
 * 例: GET {WebAppURL}?secret=xxxx
 * レスポンス: { status: 'success', accounts: [{cid, name, parentFolder}, ...] }
 */
function doGet(e) {
  try {
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (expectedSecret && (e.parameter.secret !== expectedSecret)) {
      return jsonResponse({ status: 'error', message: 'unauthorized' });
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ACCOUNT_SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    const accounts = [];
    for (let i = 1; i < data.length; i++) {
      const [cid, name, status, parentFolder, ocid] = data[i];
      if (status === '稼働中' && cid && parentFolder) {
        accounts.push({ cid: normalizeCid(cid), name, parentFolder, ocid: ocid ? String(ocid).trim() : null });
      }
    }
    return jsonResponse({ status: 'success', accounts });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // --- 簡易認証 ---
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (expectedSecret && body.secret !== expectedSecret) {
      return jsonResponse({ status: 'error', message: 'unauthorized' });
    }

    // --- アカウント実行結果の報告（画像アップロードとは別ルート） ---
    if (body.type === 'accountStatus') {
      return handleAccountStatusReport(body);
    }

    const cid = normalizeCid(body.cid);
    const filename = body.filename;
    const base64Data = body.imageBase64; // データURL prefix なしの純粋なbase64を想定
    const mimeType = body.mimeType || 'image/png';

    if (!cid || !filename || !base64Data) {
      return jsonResponse({ status: 'error', message: 'missing required fields (cid, filename, imageBase64)' });
    }

    // --- 重複チェック ---
    if (isAlreadyProcessed(cid, filename)) {
      return jsonResponse({ status: 'skipped', message: 'already processed', cid, filename });
    }

    // --- 親フォルダ取得 ---
    const parentFolderRef = getParentFolderForCid(cid);
    if (!parentFolderRef) {
      return jsonResponse({ status: 'error', message: 'CID not found in account sheet or missing parent folder', cid });
    }
    const parentFolder = DriveApp.getFolderById(extractFolderId(parentFolderRef));

    // --- CIDサブフォルダ取得 or 作成 ---
    const subFolder = getOrCreateSubFolder(parentFolder, cid);

    // --- 画像保存 ---
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename);
    const file = subFolder.createFile(blob);

    // --- ログ記録 ---
    appendLog(cid, filename, file.getId());

    return jsonResponse({
      status: 'success',
      cid,
      filename,
      driveFileId: file.getId(),
      driveFileUrl: file.getUrl()
    });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message, stack: err.stack });
  }
}

/**
 * アカウント単位の実行結果（成功/エラー）を「アカウント管理」シートのF・G列に反映する。
 * body: { cid, accountStatus: 'OK' | 'ERROR' | 'PARTIAL', message }
 *   F列: 最終稼働日（実行日時）
 *   G列: 稼働状況（OK / エラー内容）
 */
function handleAccountStatusReport(body) {
  const cid = normalizeCid(body.cid);
  if (!cid) {
    return jsonResponse({ status: 'error', message: 'cid is required for accountStatus report' });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ACCOUNT_SHEET_NAME);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const rowCid = normalizeCid(data[i][0]);
    if (rowCid === cid) {
      const rowNumber = i + 1; // シート上の実際の行番号（1-indexed、ヘッダー分+1）
      const statusText = buildStatusText(body.accountStatus, body.message);
      sheet.getRange(rowNumber, 6).setValue(new Date());   // F列: 最終稼働日
      sheet.getRange(rowNumber, 7).setValue(statusText);    // G列: 稼働状況
      return jsonResponse({ status: 'success', cid, recorded: statusText });
    }
  }

  return jsonResponse({ status: 'error', message: 'CID not found in account sheet', cid });
}

/** G列に書き込む稼働状況の文字列を組み立てる */
function buildStatusText(accountStatus, message) {
  if (accountStatus === 'OK') {
    return 'OK';
  }
  if (accountStatus === 'PARTIAL') {
    return `一部エラー: ${message || ''}`;
  }
  return `エラー: ${message || ''}`;
}

/** CIDの表記ゆれ（ハイフンあり/なし・全角半角）を吸収 */
function normalizeCid(cid) {
  if (!cid) return '';
  return cid.toString().replace(/[‐－―ー]/g, '-').trim();
}

/** URLからフォルダIDを抽出。すでにIDのみの場合はそのまま返す */
function extractFolderId(urlOrId) {
  const match = urlOrId.match(/[-\w]{25,}/);
  return match ? match[0] : urlOrId;
}

/** アカウント管理シートからCIDに対応する親フォルダ(URL/ID)を取得 */
function getParentFolderForCid(cid) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ACCOUNT_SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  // 1行目はヘッダー想定
  for (let i = 1; i < data.length; i++) {
    const rowCid = normalizeCid(data[i][0]);
    if (rowCid === cid) {
      return data[i][3]; // D列: 親Driveフォルダ
    }
  }
  return null;
}

/** 親フォルダ配下にCID名のサブフォルダを取得、なければ作成 */
function getOrCreateSubFolder(parentFolder, cid) {
  const folders = parentFolder.getFoldersByName(cid);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parentFolder.createFolder(cid);
}

/** 取得ログシートを取得（なければヘッダー付きで新規作成） */
function getLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['CID', 'ファイル名', 'DriveファイルID', '取得日時']);
  }
  return sheet;
}

/** 既に処理済み（CID + ファイル名の組み合わせ）かどうかを判定 */
function isAlreadyProcessed(cid, filename) {
  const sheet = getLogSheet();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (normalizeCid(data[i][0]) === cid && data[i][1] === filename) {
      return true;
    }
  }
  return false;
}

/** ログシートに1行追記 */
function appendLog(cid, filename, driveFileId) {
  const sheet = getLogSheet();
  sheet.appendRow([cid, filename, driveFileId, new Date()]);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 動作確認用: スプレッドシートのメニューから手動実行してログシートの中身を確認する
 */
function debugPrintLog() {
  const sheet = getLogSheet();
  Logger.log(sheet.getDataRange().getValues());
}

/**
 * デバッグ用: スクリプトプロパティに保存されているSHARED_SECRETの値を確認する。
 * 実行後、「実行ログ」でJSON化された値を確認できる（前後の空白や見えない文字も可視化される）。
 * 確認が終わったら削除してOK。
 */
function debugCheckSharedSecret() {
  const value = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  Logger.log('SHARED_SECRET = ' + JSON.stringify(value));
}
