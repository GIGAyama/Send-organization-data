// 1. 開いている単一ファイルの転送
document.getElementById('transferBtn').addEventListener('click', async () => {
  const statusDiv = document.getElementById('status');
  statusDiv.innerHTML = "処理中...<br>（ポップアップを閉じても通知でお知らせします）";
  
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    chrome.runtime.sendMessage({
      action: "transfer",
      url: tabs[0].url,
      title: tabs[0].title
    });
  });
});

// 2. Googleドライブ画面からの複数ファイル一括転送
document.getElementById('bulkTransferBtn').addEventListener('click', async () => {
  const statusDiv = document.getElementById('status');
  
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    const tab = tabs[0];
    
    // ドライブの画面で実行されているかチェック
    if (!tab.url.includes("drive.google.com")) {
      statusDiv.innerHTML = '<span style="color:red;">この機能は Googleドライブ の画面でのみ使用できます。</span>';
      return;
    }

    statusDiv.textContent = "選択されたファイルを読み取っています...";

    // ドライブの画面にスクリプトを注入して、選択中の要素を取得
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: getSelectedDriveFiles
    }, (results) => {
      if (chrome.runtime.lastError) {
        statusDiv.innerHTML = `<span style="color:red;">エラー: 画面の読み取りに失敗しました。ページをリロード（F5）して再度お試しください。</span>`;
        return;
      }

      const selectedFiles = results[0].result;
      
      if (!selectedFiles || selectedFiles.length === 0) {
        statusDiv.innerHTML = '<span style="color:red;">選択されたファイルが見つかりません。転送したいファイルをクリック（複数ある場合はCtrlやShiftキーを押しながらクリック）して選択してから実行してください。</span>';
        return;
      }

      statusDiv.innerHTML = `<span style="color:green;">${selectedFiles.length} 件の転送を開始しました！</span><br><br>ポップアップを閉じても裏側で処理されます。完了するとデスクトップ通知でお知らせします。`;
      
      // バックグラウンドへ一括転送依頼を送信
      chrome.runtime.sendMessage({
        action: "bulk_transfer",
        urls: selectedFiles
      });
    });
  });
});

// ▼ 注入されてGoogleドライブの画面（DOM）から情報を抜き出す関数
function getSelectedDriveFiles() {
  const files = [];
  
  // Google Drive上で選択されているアイテムは 'aria-selected="true"' が付与される
  const selectedNodes = document.querySelectorAll('[aria-selected="true"]');
  
  selectedNodes.forEach(node => {
    // 選択された要素の中にあるリンク(aタグ)を探す
    const link = node.tagName === 'A' ? node : node.querySelector('a');
    
    // docs.google.com を含むリンク（スプレッドシートやドキュメント等）のみを対象とする
    if (link && link.href && link.href.includes('docs.google.com')) {
      let title = node.getAttribute('aria-label') || link.textContent || "無題のファイル";
      
      // スクリーンリーダー用の余分なテキストを除去
      title = title.replace(/を選択しました.*/, '').trim();
      title = title.replace(/。$/, '').trim(); 
      
      files.push({ url: link.href, title: title });
    }
  });

  // 同じURLが複数回抽出されるのを防ぐ（重複排除）
  return Array.from(new Map(files.map(item => [item.url, item])).values());
}
