// ▼必ず新しく発行したGASのウェブアプリURLに書き換えてください
const GAS_URL = "https://script.google.com/macros/s/AKfycbwbUXIgUW0cBBoeHE-E_vSJ8dLkFCOy7t9_EZbax1C5jjwfX9sPSL7AEsEaUOhwLfSe/exec";

// ▼ 新規追加: インストール時のコンテキストメニュー作成
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "transfer_file",
    title: "個人アカウントへ転送",
    contexts: ["all"],
    documentUrlPatterns: ["https://docs.google.com/*", "https://drive.google.com/*"]
  });
});

// ▼ 変更: コンテキストメニューがクリックされた時の処理（複数選択対応）
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "transfer_file") {
    // ドライブの画面で実行された場合は、選択中の複数ファイルを取得を試みる
    if (tab.url.includes("drive.google.com")) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          function: getSelectedDriveFiles
        });
        
        const selectedFiles = results?.[0]?.result;
        
        if (selectedFiles && selectedFiles.length > 0) {
          // 複数ファイルまたは単一の選択されたファイル
          processBulkTransfer(selectedFiles);
          return;
        }
      } catch (err) {
        console.warn("DOM抽出に失敗:", err);
      }
    }

    // 選択されたファイルが見つからない、またはDrive以外の画面の場合は、クリックした要素からURLを取得
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

  try {
    // API制限を避けるため直列（順番）に処理します
    for (let i = 0; i < urls.length; i++) {
      try {
        const res = await handleTransfer(urls[i].url, urls[i].title);
        if (res.status === "success") successCount++;
      } catch (e) {
        console.error(`Error transferring ${urls[i].title}:`, e);
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
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title: "一括転送完了",
    message: `${total} 件中 ${successCount} 件の転送に成功しました。\n個人アカウントのドライブをご確認ください。`,
    requireInteraction: true
  });

  return successCount;
}

// ▼ Service Workerの強制終了を防ぐ（定期的にChrome APIを呼んでタイマーをリセット）
function startKeepAlive() {
  const id = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  return () => clearInterval(id);
}

// ▼ 転送のルーター: URLパターンに応じて適切なハンドラへ振り分ける
async function handleTransfer(url, title) {
  let resolvedUrl = url;

  // パターン0: URL解決 (Driveの汎用URLの場合、Docs/Sheets/Slidesの実体か判定するため)
  const genericDriveMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9-_]+)/);
  if (genericDriveMatch) {
    resolvedUrl = await resolveDriveUrl(genericDriveMatch[1]);
  }

  // パターン1: Google ドキュメント / スプレッドシート / スライド
  const googleDocMatch = resolvedUrl.match(/\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9-_]+)/);
  if (googleDocMatch) {
    return handleGoogleDocTransfer(googleDocMatch[1], googleDocMatch[2], title);
  }

  // パターン2: Drive上の一般ファイル（PDF, 画像など実バイナリ）
  const driveFileMatch = resolvedUrl.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9-_]+)/);
  if (driveFileMatch) {
    return handleDriveFileTransfer(driveFileMatch[1], title);
  }

  throw new Error("対応していないファイル形式です。\nGoogleドキュメント/スプレッドシート/スライド、\nまたはドライブ上のファイル（PDF・画像等）で実行してください。");
}

// ▼ 新規追加: DriveのIDからリダイレクト先（本当のファイル種類URL）を解決する
async function resolveDriveUrl(fileId) {
  try {
    const openUrl = `https://drive.google.com/open?id=${fileId}`;
    const response = await fetch(openUrl, { method: "HEAD", redirect: "follow" });
    return response.url; // リダイレクト後の最終URLを返す
  } catch (err) {
    console.warn("URL解決に失敗しました。元のURLを利用します:", err);
    return `https://drive.google.com/file/d/${fileId}/view`;
  }
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
  return await sendToGAS(payload);
}

// ▼ GASへの送信を一元管理（レスポンス検証付き）
async function sendToGAS(payload) {
  const response = await fetch(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`GASサーバーエラー (HTTP ${response.status})。デプロイURLが正しいか確認してください。`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("GASからの応答を解析できませんでした。GASのデプロイURLが正しいか確認してください。");
  }

  return result;
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

// ▼ 注入用関数: Googleドライブの画面（DOM）から選択されているファイル群を抽出する
function getSelectedDriveFiles() {
  const files = [];

  let selectedNodes = Array.from(document.querySelectorAll('[aria-selected="true"]'));

  if (selectedNodes.length === 0) {
    const checked = document.querySelectorAll('[role="checkbox"][aria-checked="true"]');
    selectedNodes = Array.from(checked).map(cb =>
      cb.closest('[data-id]') || cb.closest('[role="row"]') || cb.closest('[role="option"]')
    ).filter(Boolean);
  }

  // 右クリックした要素自体も含めるためのフォールバック (選択状態でなくても右クリックされた要素を救うのは困難だが可能な範囲で)
  
  selectedNodes.forEach(node => {
    let fileId = null;
    let title = null;
    let url = null;

    const selfOrAncestor = node.closest('[data-id]');
    if (selfOrAncestor) {
      fileId = selfOrAncestor.getAttribute('data-id');
    } else {
      const child = node.querySelector('[data-id]');
      if (child) fileId = child.getAttribute('data-id');
    }

    const links = node.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.href;
      if (href.includes('docs.google.com') || href.includes('drive.google.com/file/')) {
        url = href;
        if (!fileId) {
          const idMatch = href.match(/\/d\/([a-zA-Z0-9-_]+)/);
          if (idMatch) fileId = idMatch[1];
        }
        break;
      }
    }

    if (fileId && !url) {
      url = 'https://drive.google.com/file/d/' + fileId + '/view';
    }

    title = node.getAttribute('aria-label') || '';
    if (!title) {
      const tip = node.querySelector('[data-tooltip]');
      if (tip) title = tip.getAttribute('data-tooltip');
    }
    if (!title) {
      title = (node.textContent || '').trim().split('\n')[0] || '無題のファイル';
    }
    title = title.replace(/を選択しました.*/, '').trim();
    title = title.replace(/。$/, '').trim();

    if (fileId || url) {
      files.push({ url: url || `https://drive.google.com/file/d/${fileId}/view`, title: title, fileId: fileId });
    }
  });

  const key = item => item.fileId || item.url;
  return Array.from(new Map(files.map(item => [key(item), item])).values());
}
