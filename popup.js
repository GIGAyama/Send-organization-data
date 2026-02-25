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

  // --- ステップ1: 選択されたアイテムを検出 ---
  // Google Drive上で選択されているアイテムは 'aria-selected="true"' が付与される
  let selectedNodes = Array.from(document.querySelectorAll('[aria-selected="true"]'));

  // フォールバック: チェックボックスが選択状態のアイテムを探す
  if (selectedNodes.length === 0) {
    const checked = document.querySelectorAll('[role="checkbox"][aria-checked="true"]');
    selectedNodes = Array.from(checked).map(cb =>
      cb.closest('[data-id]') || cb.closest('[role="row"]') || cb.closest('[role="option"]')
    ).filter(Boolean);
  }

  selectedNodes.forEach(node => {
    let fileId = null;
    let title = null;
    let url = null;

    // --- ステップ2: ファイルIDを取得（最も信頼性が高い） ---
    // data-id は自分自身 → 祖先 → 子孫 の順で探す
    const selfOrAncestor = node.closest('[data-id]');
    if (selfOrAncestor) {
      fileId = selfOrAncestor.getAttribute('data-id');
    } else {
      const child = node.querySelector('[data-id]');
      if (child) fileId = child.getAttribute('data-id');
    }

    // --- ステップ3: リンクからURLを探す ---
    const links = node.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.href;
      if (href.includes('docs.google.com') || href.includes('drive.google.com/file/')) {
        url = href;
        // URLからもファイルIDを抽出（data-idが無かった場合の保険）
        if (!fileId) {
          const idMatch = href.match(/\/d\/([a-zA-Z0-9-_]+)/);
          if (idMatch) fileId = idMatch[1];
        }
        break;
      }
    }

    // ファイルIDはあるがURLが無い場合、汎用DriveURLを組み立てる
    if (fileId && !url) {
      url = 'https://drive.google.com/file/d/' + fileId + '/view';
    }

    // --- ステップ4: タイトルを取得 ---
    title = node.getAttribute('aria-label') || '';
    if (!title) {
      const tip = node.querySelector('[data-tooltip]');
      if (tip) title = tip.getAttribute('data-tooltip');
    }
    if (!title) {
      title = (node.textContent || '').trim().split('\n')[0] || '無題のファイル';
    }
    // スクリーンリーダー用の余分なテキストを除去
    title = title.replace(/を選択しました.*/, '').trim();
    title = title.replace(/。$/, '').trim();

    // --- ステップ5: ファイルとして有効な場合のみ追加 ---
    if (fileId || url) {
      files.push({ url: url, title: title, fileId: fileId });
    }
  });

  // 同じファイルが複数回抽出されるのを防ぐ（重複排除）
  const key = item => item.fileId || item.url;
  return Array.from(new Map(files.map(item => [key(item), item])).values());
}
