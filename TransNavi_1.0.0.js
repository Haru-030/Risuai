//@name TransNavi
//@display-name Trans Navi
//@api 3.0
//@version 1.0.0

(async () => {
  // ── Constants ──
  const WIDGET_ATTR = 'x-transnavi-widget';
  const PANEL_ATTR = 'x-transnavi-panel';
  const SYNC_INTERVAL_MS = 350;

  // ── State ──
  let widgetEl = null;
  let panelEl = null;
  let syncTimer = null;
  let lastVisibleIdx = -1;
  let lastActiveEl = null;
  let lastActiveRole = null;
  let msgElements = [];
  let origMessages = [];
  let panelOpen = false;

  // Drag state
  let isDragging = false;
  let dragShiftX = 0;
  let dragShiftY = 0;
  let globalPointerMoveId = null;
  let globalPointerUpId = null;
  let handleRef = null;
  let btnRef = null;

  // Chat screen observer
  let domObserver = null;
  let obsTimer = null;
  let lastChatState = null;

  // Chat index map (nth-child → data-chat-index mapping)
  let chatIndexMap = null;
  let chatIndexMapReverse = null; // data-chat-index → nth-child

  // ── Helpers ──

  const getOriginalMessages = async () => {
    try {
      const db = await Risuai.getDatabase();
      const charIdx = await Risuai.getCurrentCharacterIndex();
      const chatIdx = await Risuai.getCurrentChatIndex();
      if (!db || charIdx === -1 || chatIdx === -1) return [];
      const character = db.characters[charIdx];
      if (!character) return [];
      const chatData = character.chats[chatIdx];
      const msgs = Array.isArray(chatData) ? chatData : (chatData?.message || []);
      return msgs.map((m, i) => ({
        index: i,
        role: m.role,
        data: m.data,
        name: m.name || ''
      }));
    } catch (e) { return []; }
  };

  const buildChatIndexMap = async (rootDoc) => {
    try {
      const container = await rootDoc.querySelector('.flex-col-reverse');
      if (!container) return false;
      const html = await container.getInnerHTML();
      if (!html) return false;
      const matches = [...html.matchAll(/data-chat-index="(-?\d+)"/g)];
      chatIndexMap = {};
      chatIndexMapReverse = {};
      for (let i = 0; i < matches.length; i++) {
        const chatIdx = parseInt(matches[i][1], 10);
        chatIndexMap[i + 1] = chatIdx;         // nth-child(1-based) → chatIndex
        chatIndexMapReverse[chatIdx] = i + 1;  // chatIndex → nth-child
      }
      return true;
    } catch (e) { return false; }
  };

  const binarySearchVisibleNth = async (rootDoc) => {
    let totalCount = 0;
    try {
      const all = await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container');
      totalCount = all.length;
    } catch (e) { return -1; }

    if (totalCount === 0) return -1;

    let low = 1;
    let high = totalCount;
    const centerY = window.innerHeight / 2;
    let closest = 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const el = await rootDoc.querySelector(`.flex-col-reverse > .chat-message-container:nth-child(${mid})`);
      if (!el) { high = mid - 1; continue; }
      const rect = await el.getBoundingClientRect();
      if (rect.top <= centerY && rect.bottom >= centerY) return mid;
      if (rect.top > centerY) {
        low = mid + 1;
        closest = mid;
      } else {
        high = mid - 1;
      }
    }
    return closest;
  };

  const findVisibleChatIndex = async (rootDoc) => {
    const nthIdx = await binarySearchVisibleNth(rootDoc);
    if (nthIdx === -1) return -1;
    if (!chatIndexMap || chatIndexMap[nthIdx] === undefined) {
      await buildChatIndexMap(rootDoc);
    }
    return chatIndexMap ? (chatIndexMap[nthIdx] ?? -1) : -1;
  };

  const escapeHtml = (s) => {
    if (!s) return '';
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  };

  // ── Chat Screen Detection ──

  const checkChatScreen = async () => {
    try {
      const rootDoc = await Risuai.getRootDocument();
      if (!rootDoc) return;
      const chatContainer = await rootDoc.querySelector('.flex-col-reverse');
      const isChat = !!chatContainer;
      if (isChat === lastChatState) return;
      lastChatState = isChat;
      if (widgetEl) {
        await widgetEl.setStyle('display', isChat ? 'flex' : 'none');
      }
      if (!isChat && panelEl) {
        await closePanel();
      }
    } catch (e) {}
  };

  const startChatObserver = async () => {
    if (domObserver) return;
    try {
      const rootDoc = await Risuai.getRootDocument();
      if (!rootDoc) return;
      const body = await rootDoc.querySelector('body');
      domObserver = await Risuai.createMutationObserver(async () => {
        if (obsTimer) clearTimeout(obsTimer);
        obsTimer = setTimeout(checkChatScreen, 300);
      });
      await domObserver.observe(body, { childList: true, subtree: true });
    } catch (e) {}
  };

  // ── Floating Widget ──

  const createWidget = async () => {
    const rootDoc = await Risuai.getRootDocument();
    if (!rootDoc) return;
    const body = await rootDoc.querySelector('body');

    // Remove existing
    const existing = await rootDoc.querySelector(`[${WIDGET_ATTR}]`);
    if (existing) await existing.remove();

    const container = await rootDoc.createElement('div');
    await container.setAttribute(WIDGET_ATTR, 'true');
    await container.setStyleAttribute(`
      position: fixed;
      bottom: 100px;
      right: 20px;
      width: 48px;
      height: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: center;
      z-index: 9999;
      padding: 6px;
      padding-top: 4px;
      border-radius: 10px;
      user-select: none;
      -webkit-user-select: none;
      cursor: default;
      touch-action: none;
    `);

    // Drag handle
    const handle = await rootDoc.createElement('div');
    await handle.setStyleAttribute(`
      width: 24px;
      height: 6px;
      background-color: rgba(255,255,255,0.3);
      border-radius: 3px;
      cursor: move;
      margin-bottom: 1px;
      flex-shrink: 0;
      pointer-events: none;
      transition: background-color 0.2s;
    `);
    handleRef = handle;

    // Toggle button
    const btn = await rootDoc.createElement('div');
    await btn.setStyleAttribute(`
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.9);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      pointer-events: none;
      transition: background 0.2s;
    `);
    // Document/page icon
    await btn.setInnerHTML(`<svg style="pointer-events:none;width:20px;height:20px;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`);
    btnRef = btn;

    await container.appendChild(handle);
    await container.appendChild(btn);
    await body.appendChild(container);
    widgetEl = container;

    // Apply mobile fix
    const divs = await container.querySelectorAll('div');
    for (const div of divs) {
      await div.setStyle('touch-action', 'none');
    }

    // Click → toggle panel
    await container.addEventListener('click', async (e) => {
      if (isDragging) return;
      const clientX = e.clientX;
      const clientY = e.clientY;
      if (clientX === undefined || clientY === undefined || !btnRef) return;
      const btnRect = await btnRef.getBoundingClientRect();
      if (clientX >= btnRect.left && clientX <= btnRect.right &&
          clientY >= btnRect.top && clientY <= btnRect.bottom) {
        await togglePanel();
      }
    });

    // Drag
    try {
      await container.addEventListener('pointerdown', async (e) => {
        if (e.button !== 0 && e.button !== -1) return;
        const clientX = e.clientX;
        const clientY = e.clientY;
        if (clientX === undefined || clientY === undefined || !handleRef) return;

        const handleRect = await handleRef.getBoundingClientRect();
        if (clientX < handleRect.left || clientX > handleRect.right ||
            clientY < handleRect.top || clientY > handleRect.bottom) return;

        isDragging = true;
        const rect = await container.getBoundingClientRect();
        dragShiftX = clientX - rect.left;
        dragShiftY = clientY - rect.top;

        await handleRef.setStyle('backgroundColor', 'rgba(255,255,255,0.8)');

        if (globalPointerMoveId) await body.removeEventListener('pointermove', globalPointerMoveId);
        if (globalPointerUpId) await body.removeEventListener('pointerup', globalPointerUpId);

        globalPointerMoveId = await body.addEventListener('pointermove', async (ev) => {
          if (!isDragging || !widgetEl) return;
          if (ev.preventDefault) ev.preventDefault();
          await widgetEl.setStyle('bottom', 'auto');
          await widgetEl.setStyle('right', 'auto');
          await widgetEl.setStyle('left', `${ev.clientX - dragShiftX}px`);
          await widgetEl.setStyle('top', `${ev.clientY - dragShiftY}px`);
        });

        globalPointerUpId = await body.addEventListener('pointerup', async () => {
          if (isDragging) {
            isDragging = false;
            if (handleRef) await handleRef.setStyle('backgroundColor', 'rgba(255,255,255,0.3)');
          }
          if (globalPointerMoveId) await body.removeEventListener('pointermove', globalPointerMoveId);
          if (globalPointerUpId) await body.removeEventListener('pointerup', globalPointerUpId);
          globalPointerMoveId = null;
          globalPointerUpId = null;
        });
      });
    } catch (dragErr) {}
  };

  // ── Panel ──

  const closePanel = async () => {
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    if (panelEl) {
      try { await panelEl.remove(); } catch (e) {}
      panelEl = null;
    }
    panelOpen = false;
    lastVisibleIdx = -1;
    lastActiveEl = null;
    lastActiveRole = null;
    msgElements = [];
    chatIndexMap = null;
    chatIndexMapReverse = null;
  };

  const togglePanel = async () => {
    if (panelOpen) {
      await closePanel();
      return;
    }

    const rootDoc = await Risuai.getRootDocument();
    if (!rootDoc) return;
    const body = await rootDoc.querySelector('body');

    // Remove stale panels
    const existing = await rootDoc.querySelector(`[${PANEL_ATTR}]`);
    if (existing) await existing.remove();

    // Load messages
    origMessages = await getOriginalMessages();
    if (origMessages.length === 0) return;

    // Build index map for scroll sync
    await buildChatIndexMap(rootDoc);

    // ── Panel Container ──
    const panel = await rootDoc.createElement('div');
    await panel.setAttribute(PANEL_ATTR, 'true');
    await panel.setStyleAttribute(`
      position: fixed;
      top: 0;
      right: 0;
      width: 380px;
      height: 100vh;
      background: #1a1a2e;
      border-left: 1px solid rgba(255,255,255,0.1);
      z-index: 9998;
      display: flex;
      flex-direction: column;
      box-shadow: -4px 0 20px rgba(0,0,0,0.3);
    `);

    // ── Header ──
    const header = await rootDoc.createElement('div');
    await header.setStyleAttribute(`
      padding: 14px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
      background: #16213e;
    `);
    const title = await rootDoc.createElement('div');
    await title.setStyleAttribute(`font-size: 15px; font-weight: 600; color: #e0e0e0;`);
    await title.setInnerHTML('Trans Navi &#8212; &#50896;&#47928; &#48372;&#44592;');

    const msgCount = await rootDoc.createElement('div');
    await msgCount.setStyleAttribute(`font-size: 11px; color: #888; margin-left: 8px;`);
    await msgCount.setInnerHTML(`${origMessages.length}&#44060;`);

    const titleRow = await rootDoc.createElement('div');
    await titleRow.setStyleAttribute(`display: flex; align-items: baseline;`);
    await titleRow.appendChild(title);
    await titleRow.appendChild(msgCount);

    const closeBtn = await rootDoc.createElement('div');
    await closeBtn.setStyleAttribute(`
      color: #888;
      font-size: 18px;
      padding: 4px 8px;
      border-radius: 6px;
      pointer-events: none;
      transition: color 0.2s;
    `);
    await closeBtn.setInnerHTML('&#10005;');

    await header.appendChild(titleRow);
    await header.appendChild(closeBtn);
    await panel.appendChild(header);

    // ── Scrollable Message Area ──
    const area = await rootDoc.createElement('div');
    await area.setStyleAttribute(`
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      scroll-behavior: smooth;
    `);

    msgElements = [];
    for (const m of origMessages) {
      const msgDiv = await rootDoc.createElement('div');
      await msgDiv.setAttribute('x-tn-idx', String(m.index));
      const isUser = m.role === 'user';
      await msgDiv.setStyleAttribute(`
        margin-bottom: 12px;
        padding: 10px 14px;
        border-radius: 10px;
        background: ${isUser ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.04)'};
        border-left: 3px solid ${isUser ? '#3b82f6' : '#a78bfa'};
        transition: background 0.3s, border-left-color 0.3s;
      `);

      // Index badge
      const badge = await rootDoc.createElement('div');
      await badge.setStyleAttribute(`
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
      `);

      const roleLabel = await rootDoc.createElement('span');
      await roleLabel.setStyleAttribute(`
        font-size: 11px;
        font-weight: 600;
        color: ${isUser ? '#60a5fa' : '#a78bfa'};
        text-transform: uppercase;
      `);
      await roleLabel.setInnerHTML(isUser ? 'USER' : (m.name || 'CHAR'));

      const idxLabel = await rootDoc.createElement('span');
      await idxLabel.setStyleAttribute(`font-size: 10px; color: #555;`);
      await idxLabel.setInnerHTML(`#${m.index}`);

      await badge.appendChild(roleLabel);
      await badge.appendChild(idxLabel);

      const content = await rootDoc.createElement('div');
      await content.setStyleAttribute(`
        font-size: 13px;
        color: #d1d5db;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
      `);
      await content.setInnerHTML(escapeHtml(m.data));

      await msgDiv.appendChild(badge);
      await msgDiv.appendChild(content);
      await area.appendChild(msgDiv);

      msgElements.push({ index: m.index, el: msgDiv, role: m.role });
    }

    await panel.appendChild(area);
    await body.appendChild(panel);
    panelEl = panel;
    panelOpen = true;

    // ── Close Handler ──
    await panel.addEventListener('click', async (e) => {
      const clientX = e.clientX;
      const clientY = e.clientY;
      if (clientX === undefined || clientY === undefined) return;
      const r = await closeBtn.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right &&
          clientY >= r.top && clientY <= r.bottom) {
        await closePanel();
      }
    });

    // ── Click-to-Navigate: Click a message in panel → scroll main chat ──
    await panel.addEventListener('click', async (e) => {
      const clientX = e.clientX;
      const clientY = e.clientY;
      if (clientX === undefined || clientY === undefined) return;

      for (const me of msgElements) {
        const rect = await me.el.getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right &&
            clientY >= rect.top && clientY <= rect.bottom) {
          // Navigate main chat to this message
          try {
            if (!chatIndexMapReverse) await buildChatIndexMap(rootDoc);
            const nthIdx = chatIndexMapReverse ? chatIndexMapReverse[me.index] : null;
            if (nthIdx) {
              const target = await rootDoc.querySelector(
                `.flex-col-reverse > .chat-message-container:nth-child(${nthIdx})`
              );
              if (target) {
                await target.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }
            } else {
              // Fallback: direct attribute selector
              const target = await rootDoc.querySelector(`[data-chat-index="${me.index}"]`);
              if (target) {
                await target.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }
            }
          } catch (navErr) {}
          break;
        }
      }
    });

    // ── Scroll Sync (main chat → panel) ──
    lastVisibleIdx = -1;
    lastActiveEl = null;
    lastActiveRole = null;

    syncTimer = setInterval(async () => {
      try {
        if (!panelOpen || !panelEl) {
          clearInterval(syncTimer);
          syncTimer = null;
          return;
        }

        const vIdx = await findVisibleChatIndex(rootDoc);
        if (vIdx === -1 || vIdx === lastVisibleIdx) return;
        lastVisibleIdx = vIdx;

        // Reset previous highlight
        if (lastActiveEl) {
          const isU = lastActiveRole === 'user';
          await lastActiveEl.setStyle('background',
            isU ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.04)');
          await lastActiveEl.setStyle('borderLeftColor',
            isU ? '#3b82f6' : '#a78bfa');
        }

        // Highlight new
        const me = msgElements.find(x => x.index === vIdx);
        if (me) {
          await me.el.setStyle('background', 'rgba(250,204,21,0.15)');
          await me.el.setStyle('borderLeftColor', '#facc15');
          await me.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          lastActiveEl = me.el;
          lastActiveRole = me.role;
        }
      } catch (e) {}
    }, SYNC_INTERVAL_MS);
  };

  // ── Initialization ──
  try {
    await createWidget();
    await startChatObserver();
    await checkChatScreen();

    // Register in chat menu
    await Risuai.registerButton({
      name: 'Trans Navi',
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>`,
      iconType: 'html',
      location: 'chat'
    }, async () => {
      await togglePanel();
    });

    // Cleanup on unload
    Risuai.onUnload(async () => {
      try {
        if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
        if (obsTimer) { clearTimeout(obsTimer); obsTimer = null; }
        if (domObserver) {
          try { await domObserver.disconnect(); } catch (e) {}
        }
        const rootDoc = await Risuai.getRootDocument();
        if (!rootDoc) return;
        const w = await rootDoc.querySelector(`[${WIDGET_ATTR}]`);
        if (w) await w.remove();
        const p = await rootDoc.querySelector(`[${PANEL_ATTR}]`);
        if (p) await p.remove();
        const body = await rootDoc.querySelector('body');
        if (globalPointerMoveId) await body.removeEventListener('pointermove', globalPointerMoveId);
        if (globalPointerUpId) await body.removeEventListener('pointerup', globalPointerUpId);
      } catch (e) {}
    });
  } catch (e) {}
})();
