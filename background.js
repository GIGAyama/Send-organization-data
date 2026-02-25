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

// ▼ 既存の handleTransfer 関数はそのまま残します
async function handleTransfer(url, title) {
  const match = url.match(/\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error("Googleドキュメント、スプレッドシート、スライドの画面で実行してください。");
  
  const type = match[1];
  const id = match[2];
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
    headers: { "Content-Type": "text/plain" }, // CORS回避のためtext/plainを使用
    body: JSON.stringify(payload)
  });
  
  return await gasResponse.json();
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
