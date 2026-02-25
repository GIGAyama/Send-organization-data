// ▼必ず新しく発行したGASのウェブアプリURLに書き換えてください
const GAS_URL = "https://script.google.com/macros/s/AKfycbwbUXIgUW0cBBoeHE-E_vSJ8dLkFCOy7t9_EZbax1C5jjwfX9sPSL7AEsEaUOhwLfSe/exec";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "transfer") {
    handleTransfer(request.url, request.title)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ status: "error", message: err.toString() }));
    return true; // 非同期通信のために必須
  }
});

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
