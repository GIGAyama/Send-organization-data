// ▼必ず新しく発行したGASのウェブアプリURLに書き換えてください
const GAS_URL = "https://script.google.com/macros/s/AKfycbwbUXIgUW0cBBoeHE-E_vSJ8dLkFCOy7t9_EZbax1C5jjwfX9sPSL7AEsEaUOhwLfSe/exec";

// ▼ コンテキストメニューの作成（removeAllで既存を消してから再作成）
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    // Google系リンクを右クリックした時（任意のページで表示される）
    chrome.contextMenus.create({
      id: "transfer_link",
      title: "個人アカウントへ転送",
      contexts: ["link"],
      targetUrlPatterns: ["https://docs.google.com/*", "https://drive.google.com/*"]
    });
    // Google系ページ自体を右クリックした時（Shift+右クリック等でネイティブメニューが出た場合）
    chrome.contextMenus.create({
      id: "transfer_page",
      title: "このページを個人アカウントへ転送",
      contexts: ["page"],
      documentUrlPatterns: ["https://docs.google.com/*", "https://drive.google.com/*"]
    });
  });
}
// インストール/更新時 と Chrome起動時 の両方でメニューを確実に作成
chrome.runtime.onInstalled.addListener(setupContextMenus);
chrome.runtime.onStartup.addListener(setupContextMenus);

// ▼ コンテキストメニューがクリックされた時の処理
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "transfer_link") {
    startTransferWithNotification(info.linkUrl, tab.title || "リンクからの転送");
  } else if (info.menuItemId === "transfer_page") {
    startTransferWithNotification(info.pageUrl || tab.url, tab.title || "ページからの転送");
  }
});

// ▼ 新規追加: 通知をクリックした時にコピー先URLを開く処理
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.storage.local.get(notificationId, (result) => {
    if (result[notificationId]) {
      chrome.tabs.create({ url: result[notificationId] });
      chrome.storage.local.remove(notificationId); // 履歴を消去
    }
  });
});

// ▼ 変更: メッセージ受信処理に一括転送の分岐を追加
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "transfer") {
    startTransferWithNotification(request.url, request.title)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ status: "error", message: err.toString() }));
    return true; // 非同期通信のために必須
  }
  
  if (request.action === "bulk_transfer") {
    processBulkTransfer(request.urls)
      .then(res => sendResponse({ status: "success", count: res }))
      .catch(err => sendResponse({ status: "error", message: err.toString() }));
    return true;
  }
});

// ▼ 新規追加: 通知付きの単一転送ラップ関数
async function startTransferWithNotification(url, title) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.png",
      title: "転送開始",
      message: `${title}\nの転送を開始しました...`
    });

    const res = await handleTransfer(url, title);
    
    if (res.status === "success") {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icon.png",
        title: "転送成功！",
        message: `コピー完了: ${title}\n【ここをクリックして開く】`,
        requireInteraction: true // ユーザーがクリックするまで残す
      }, (notificationId) => {
        chrome.storage.local.set({ [notificationId]: res.url });
      });
    } else {
      throw new Error(res.message);
    }
    return res;
  } catch (error) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.png",
      title: "転送エラー",
      message: error.toString()
    });
    throw error;
  }
}

// ▼ 一括転送のループ処理関数（進捗通知・keepalive付き）
async function processBulkTransfer(urls) {
  let successCount = 0;
  const total = urls.length;
  const PROGRESS_ID = "bulk_transfer_progress";

  chrome.notifications.create(PROGRESS_ID, {
    type: "basic",
    iconUrl: "icon.png",
    title: "一括転送中",
    message: `0/${total} 件完了（処理中...）`
  });

  // Service Workerが長時間処理中に停止するのを防ぐ
  const stopKeepAlive = startKeepAlive();

  let lastError = "";

  try {
    // API制限を避けるため直列（順番）に処理します
    for (let i = 0; i < urls.length; i++) {
      try {
        let res;
        if (urls[i].fileId) {
          // fileIDがある場合はURLの組み立て→再パースを省略し直接転送
          res = await handleTransferByFileId(urls[i].fileId, urls[i].title);
        } else if (urls[i].url) {
          res = await handleTransfer(urls[i].url, urls[i].title);
        } else {
          throw new Error("ファイル情報を取得できませんでした");
        }
        if (res.status === "success") successCount++;
      } catch (e) {
        console.error(`Error transferring ${urls[i].title}:`, e);
        lastError = e.message || e.toString();
      }
      // 進捗を通知に反映
      chrome.notifications.update(PROGRESS_ID, {
        message: `${i + 1}/${total} 件完了（${successCount} 件成功）`
      });
    }
  } finally {
    stopKeepAlive();
  }

  // 進捗通知を消して完了通知に切り替え
  chrome.notifications.clear(PROGRESS_ID);
  const completionMessage = successCount === total
    ? `${total} 件すべて転送に成功しました。\n個人アカウントのドライブをご確認ください。`
    : `${total} 件中 ${successCount} 件の転送に成功しました。`
      + (lastError ? `\n最後のエラー: ${lastError}` : '');
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title: "一括転送完了",
    message: completionMessage,
    requireInteraction: true
  });

  return successCount;
}

// ▼ Service Workerの強制終了を防ぐ（定期的にChrome APIを呼んでタイマーをリセット）
function startKeepAlive() {
  const id = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  return () => clearInterval(id);
}

// ▼ ファイルIDから直接転送を試みる（一括転送用）
// URL組み立て→再パースの迂回を避け、fileIdから直接エクスポートを試行
async function handleTransferByFileId(fileId, title) {
  // 1. まずGoogleネイティブファイル（Docs/Sheets/Slides）としてエクスポートを試みる
  const types = ['document', 'spreadsheets', 'presentation'];
  for (const type of types) {
    try {
      return await handleGoogleDocTransfer(type, fileId, title);
    } catch {
      // この形式ではなかった → 次を試す
    }
  }
  // 2. Googleネイティブでなければ通常ファイル（PDF・画像等）としてダウンロード
  return handleDriveFileTransfer(fileId, title);
}

// ▼ 転送のルーター: URLパターンに応じて適切なハンドラへ振り分ける
async function handleTransfer(url, title) {
  // パターン1: Google ドキュメント / スプレッドシート / スライド
  const googleDocMatch = url.match(/\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9-_]+)/);
  if (googleDocMatch) {
    return handleGoogleDocTransfer(googleDocMatch[1], googleDocMatch[2], title);
  }

  // パターン2: Drive上の一般ファイル（PDF, 画像など）
  const driveFileMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9-_]+)/);
  if (driveFileMatch) {
    return handleDriveFileTransfer(driveFileMatch[1], title);
  }

  // パターン3: drive.google.com/open?id=... 形式（Driveの一覧画面でよく使われる）
  const driveOpenMatch = url.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9-_]+)/);
  if (driveOpenMatch) {
    return handleDriveFileTransfer(driveOpenMatch[1], title);
  }

  throw new Error("対応していないファイル形式です。\nGoogleドキュメント/スプレッドシート/スライド、\nまたはドライブ上のファイル（PDF・画像等）で実行してください。");
}

// ▼ Google ドキュメント / スプレッドシート / スライド の転送
async function handleGoogleDocTransfer(type, id, title) {
  let exportUrl, mimeType, targetMimeType, ext;

  if (type === 'document') {
    exportUrl = `https://docs.google.com/document/d/${id}/export?format=docx`;
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    targetMimeType = 'application/vnd.google-apps.document';
    ext = '.docx';
  } else if (type === 'spreadsheets') {
    exportUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
    mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    targetMimeType = 'application/vnd.google-apps.spreadsheet';
    ext = '.xlsx';
  } else if (type === 'presentation') {
    exportUrl = `https://docs.google.com/presentation/d/${id}/export/pptx`;
    mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    targetMimeType = 'application/vnd.google-apps.presentation';
    ext = '.pptx';
  }

  // 1. エクスポートファイルのダウンロード
  const response = await fetch(exportUrl);
  if (!response.ok) throw new Error("ファイルのエクスポートに失敗しました。");

  // エクスポート結果の検証（HTMLが返った場合はファイル形式の不一致）
  const responseType = (response.headers.get('Content-Type') || '').split(';')[0].trim();
  if (responseType === 'text/html') {
    throw new Error("エクスポート形式が不一致です。");
  }

  const blob = await response.blob();

  // 2. Service Worker環境に対応した安全なBase64変換
  const base64data = await bufferToBase64(await blob.arrayBuffer());
  const cleanTitle = title.replace(/ - Google (スプレッドシート|ドキュメント|スライド)$/, "");

  const payload = {
    fileName: cleanTitle + ext,
    mimeType: mimeType,
    targetMimeType: targetMimeType,
    base64: base64data
  };

  // 3. GASへ送信
  return await sendToGAS(payload);
}

// ▼ PDF・画像などDrive上の一般ファイルの転送
async function handleDriveFileTransfer(fileId, title) {
  // 1. ファイルをダウンロード（confirm=t で大容量ファイルのウイルススキャン確認をスキップ）
  const downloadUrl = `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error("ファイルのダウンロードに失敗しました。アクセス権限を確認してください。");

  // 2. レスポンスヘッダからMIMEタイプを取得
  const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
  const mimeType = contentType.split(';')[0].trim();

  // HTMLが返ってきた場合、Googleネイティブファイル（Docs/Sheets/Slides）の可能性がある
  // 各形式でのエクスポートを順に試み、成功したものを返す
  if (mimeType === 'text/html') {
    const types = ['document', 'spreadsheets', 'presentation'];
    for (const type of types) {
      try {
        return await handleGoogleDocTransfer(type, fileId, title);
      } catch {
        // この形式ではなかった → 次を試す
      }
    }
    throw new Error("ファイルをダウンロードできませんでした。ファイルへのアクセス権限があることを確認してください。");
  }

  // 3. ファイル名を決定
  let fileName = title.replace(/ - Google ドライブ$/, '').trim();
  // Content-Dispositionヘッダから正確なファイル名を取得（可能な場合）
  const disposition = response.headers.get('Content-Disposition');
  if (disposition) {
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;\n]+)/i);
    const plainMatch = disposition.match(/filename="?([^";\n]+)"?/i);
    if (utf8Match) {
      fileName = decodeURIComponent(utf8Match[1]);
    } else if (plainMatch) {
      fileName = plainMatch[1].trim();
    }
  }
  // 拡張子が無い場合、MIMEタイプから補完
  if (!fileName.includes('.')) {
    fileName += getExtensionFromMime(mimeType);
  }

  // 4. Base64エンコード
  const blob = await response.blob();
  const base64data = await bufferToBase64(await blob.arrayBuffer());

  const payload = {
    fileName: fileName,
    mimeType: mimeType,
    targetMimeType: "",  // 非Googleファイルは変換不要
    base64: base64data
  };

  // 5. GASへ送信
  return await sendToGAS(payload);
}

// ▼ GASへの送信を一元管理
// 注意: GAS Web Appは302リダイレクトで応答を返すため、response.okチェックは使わない。
// レスポンスをテキストで受け取ってからJSONパースすることで、エラー時の原因を可視化する。
async function sendToGAS(payload) {
  const response = await fetch(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GAS応答の解析に失敗しました: " + text.substring(0, 200));
  }
}

// ▼ MIMEタイプから拡張子を推定するヘルパー
function getExtensionFromMime(mimeType) {
  const map = {
    'application/pdf': '.pdf',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'text/html': '.html',
    'application/json': '.json',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  };
  return map[mimeType] || '';
}

// 大容量ファイルでもスタックオーバーフローを起こさないBase64変換関数
async function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}
