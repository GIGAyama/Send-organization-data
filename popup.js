document.getElementById('transferBtn').addEventListener('click', async () => {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = "処理中...（数秒かかります）";
  
  // 現在開いているタブの情報を取得
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    const currentUrl = tabs[0].url;
    const currentTitle = tabs[0].title;
    
    // バックグラウンドスクリプトへ処理を依頼
    chrome.runtime.sendMessage({
      action: "transfer",
      url: currentUrl,
      title: currentTitle
    }, (response) => {
      if (response && response.status === "success") {
        statusDiv.innerHTML = `<span style="color:green;">成功！</span><br><a href="${response.url}" target="_blank">コピー先を開く</a>`;
      } else {
        statusDiv.textContent = "エラー: " + (response ? response.message : "不明なエラー");
      }
    });
  });
});
