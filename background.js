// GASのウェブアプリURLをここに設定
const GAS_URL = "【ここにステップ1で控えたウェブアプリのURLを貼り付け】";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "transfer") {
    handleTransfer(request.url, request.title)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ status: "error", message: err.toString() }));
    return true; // 非同期でレスポンスを返すために必要
  }
});

async function handleTransfer(url, title) {
  // URLからファイルタイプとIDを抽出
  const match = url.match(/\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error("Googleドキュメント、スプレッドシート、スライドの画面で実行してください。");
  
  const type = match[1];
  const id = match[2];
  
  let exportUrl, mimeType, targetMimeType, ext;
  
  // ファイル形式に合わせてエクスポート設定を分岐
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

  // 1. 組織アカウントの権限を利用して一時エクスポート用ファイルをダウンロード
  const response = await fetch(exportUrl);
  if (!response.ok) throw new Error("ファイルのエクスポートに失敗しました。権限を確認してください。");
  const blob = await response.blob();
  
  // 2. BlobをBase64に変換
  const base64data = await blobToBase64(blob);
  
  // 3. GASのAPIへPOST送信
  const cleanTitle = title.replace(/ - Google (スプレッドシート|ドキュメント|スライド)$/, "");
  
  const payload = {
    fileName: cleanTitle + ext,
    mimeType: mimeType,
    targetMimeType: targetMimeType,
    base64: base64data.split(',')[1] // プレフィックス(data:〜)を削除
  };

  const gasResponse = await fetch(GAS_URL, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  
  return await gasResponse.json();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
