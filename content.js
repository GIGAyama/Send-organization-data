// content.js — Google Drive/Docs/Sheets/Slides のカスタム右クリックメニューに
// 「個人アカウントへ転送」オプションを注入するコンテンツスクリプト

(function() {
  // 右クリック発生後にGoogleのカスタムメニューを探してオプションを注入
  document.addEventListener('contextmenu', () => {
    let attempts = 0;
    const check = setInterval(() => {
      if (++attempts > 20) { clearInterval(check); return; }

      // Google のカスタムメニューは role="menu" または role="listbox"
      const menus = document.querySelectorAll('[role="menu"], [role="listbox"]');
      for (const menu of menus) {
        if (!isVisible(menu)) continue;
        // 既に注入済みならスキップ
        if (menu.querySelector('[data-transfer-btn]')) { clearInterval(check); return; }
        // メニュー項目が2個以上あるものだけ対象（ナビ等を除外）
        if (menu.querySelectorAll('[role="menuitem"], [role="option"]').length < 2) continue;

        injectTransferOption(menu);
        clearInterval(check);
        return;
      }
    }, 50);
  }, true); // capture phase で確実に検出

  function isVisible(el) {
    if (el.style.display === 'none' || el.style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ▼ Googleメニューの末尾に転送オプションを追加
  function injectTransferOption(menu) {
    // セパレーター
    const sep = document.createElement('div');
    sep.setAttribute('role', 'separator');
    sep.style.cssText = 'border-top: 1px solid #dadce0; margin: 4px 0;';

    // メニュー項目
    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('data-transfer-btn', 'true');
    item.style.cssText =
      'padding: 6px 16px; font-size: 14px; line-height: 32px; cursor: pointer;' +
      'color: #1a73e8; white-space: nowrap;';
    item.textContent = '個人アカウントへ転送';

    item.addEventListener('mouseenter', () => { item.style.backgroundColor = '#e8f0fe'; });
    item.addEventListener('mouseleave', () => { item.style.backgroundColor = ''; });

    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Escapeキーでメニューを閉じる
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
        bubbles: true, cancelable: true
      }));
      triggerTransfer();
    }, true);

    menu.appendChild(sep);
    menu.appendChild(item);
  }

  // ▼ 選択中のファイル情報を収集してバックグラウンドへ送信
  function triggerTransfer() {
    const files = getSelectedFiles();

    if (files.length === 0) {
      // 選択ファイルが無い場合はページ自体を転送
      chrome.runtime.sendMessage({
        action: "transfer",
        url: window.location.href,
        title: document.title
      });
    } else if (files.length === 1) {
      chrome.runtime.sendMessage({
        action: "transfer",
        url: files[0].url,
        title: files[0].title,
        fileId: files[0].fileId
      });
    } else {
      chrome.runtime.sendMessage({
        action: "bulk_transfer",
        urls: files
      });
    }
  }

  // ▼ 選択されたファイルをDOMから取得（popup.js の getSelectedDriveFiles と同等）
  function getSelectedFiles() {
    const files = [];
    let selectedNodes = Array.from(document.querySelectorAll('[aria-selected="true"]'));

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
        if (href.includes('docs.google.com') || href.includes('drive.google.com/file/') || href.includes('drive.google.com/open')) {
          url = href;
          if (!fileId) {
            const idMatch = href.match(/(?:\/d\/|[?&]id=)([a-zA-Z0-9-_]+)/);
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
        files.push({ url, title, fileId });
      }
    });

    const key = item => item.fileId || item.url;
    return Array.from(new Map(files.map(item => [key(item), item])).values());
  }
})();
