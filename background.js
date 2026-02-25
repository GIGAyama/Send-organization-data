// ▼必ず新しく発行したGASのウェブアプリURLに書き換えてください
const GAS_URL = "https://script.google.com/macros/s/AKfycbwbUXIgUW0cBBoeHE-E_vSJ8dLkFCOy7t9_EZbax1C5jjwfX9sPSL7AEsEaUOhwLfSe/exec";

// ▼ 新規追加: インストール時のコンテキストメニュー作成
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "transfer_file",
    title: "個人アカウントへ転送",
    contexts: ["page", "link"],
    documentUrlPatterns: ["https://docs.google.com/*", "https://drive.google.com/*"]
  });
});

// ▼ 新規追加: コンテキストメニューがクリックされた時の処理
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "transfer_file") {
    // リンクを右クリックした場合はリンクURL、何もない場所ならページURL
    const targetUrl = info.linkUrl || info.pageUrl || tab.url;
    startTransferWithNotification(targetUrl, tab.title || "コンテキストメニューからの転送");
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

// ▼ 新規追加: 一括転送のループ処理関数
async function processBulkTransfer(urls) {
  let successCount = 0;
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title: "一括転送開始",
    message: `合計 ${urls.length} 件の転送を開始します...\n（順次処理されるため少し時間がかかります）`
  });

  // API制限を避けるため直列（順番）に処理します
  for (const item of urls) {
    try {
      const res = await handleTransfer(item.url, item.title);
      if (res.status === "success") successCount++;
    } catch (e) {
      console.error(`Error transferring ${item.title}:`, e);
    }
  }

  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title: "一括転送完了",
    message: `${urls.length} 件中 ${successCount} 件の転送に成功しました。\n個人アカウントのドライブをご確認ください。`,
    requireInteraction: true
  });
  
  return successCount;
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
  const gasResponse = await fetch(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload)
  });

  return await gasResponse.json();
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

  // HTMLが返ってきた場合はダウンロードに失敗している（権限エラーやリダイレクト）
  if (mimeType === 'text/html') {
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
  const gasResponse = await fetch(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload)
  });

  return await gasResponse.json();
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
