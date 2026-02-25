//@name ScrollPlus
//@display-name ↕️ Scroll Plus
//@api 3.0
//@version 1.0.1
//@update-url https://host-ashen.vercel.app/ScrollPlus.js

(async () => {
  const CLICK_DELAY = 190;
  const DEBOUNCE_TIME = 100;
  
  const WIDGET_ATTR_KEY = 'x-scrollplus-widget'; 
  const WIDGET_ATTR_VAL = 'container';
  const STORAGE_KEY_THEME = 'scrollplus_theme_mode';
  const STORAGE_KEY_DBLCLICK = 'scrollplus_dblclick_enabled';
  const STORAGE_KEY_ALWAYS_SHOW = 'scrollplus_always_show';
  const STORAGE_KEY_WIDGET_SIZE = 'scrollplus_widget_size';
  const STORAGE_KEY_OUTPUT_ONLY = 'scrollplus_output_only';
  const SETTINGS_ATTR_KEY = 'x-scrollplus-settings';
  
  let upTimer = null;
  let downTimer = null;
  let isMobileFixApplied = false;
  let widgetElement = null; 
  
  let cachedIndex = -1; 
  
  let lastUpClickTime = 0;
  let lastDownClickTime = 0;
  
  let upBtnRef = null;
  let downBtnRef = null;
  let topBtnRef = null;
  let bottomBtnRef = null;
  let handleRef = null;
  let buttonMode = 'dblclick';
  let alwaysShow = false;
  let widgetSize = 'default';
  let outputOnly = false;

  const sizeConfig = {
    small:   { container: 48, btn: 32, handleW: 24, handleH: 6, icon: 18, gap: 6, pad: 6, padTop: 4, radius: 10, handleMB: 1 },
    default: { container: 60, btn: 40, handleW: 32, handleH: 8, icon: 24, gap: 8, pad: 8, padTop: 6, radius: 12, handleMB: 2 },
    large:   { container: 76, btn: 52, handleW: 40, handleH: 10, icon: 30, gap: 10, pad: 10, padTop: 8, radius: 14, handleMB: 3 }
  };

  let isDragging = false;
  let dragShiftX = 0;
  let dragShiftY = 0;
  
  let globalPointerMoveId = null;
  let globalPointerUpId = null;

  let domObserver = null;
  let observerTimer = null;
  let lastChatScreenState = null;

  const applyMobileFix = async () => {
    try {
      if (!widgetElement) return;
      const divs = await widgetElement.querySelectorAll('div'); 
      for (const div of divs) {
        await div.setStyle('touch-action', 'none');
      }
    } catch (e) {}
  };

  const binarySearchIndex = async (rootDoc) => {
    let totalCount = 0;
    try {
        const all = await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container');
        totalCount = all.length;
    } catch(e) { return -1; }
    
    if (totalCount === 0) return -1;

    let low = 1;
    let high = totalCount;
    const centerLine = window.innerHeight / 2;
    let closestIndex = 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const el = await rootDoc.querySelector(`.flex-col-reverse > .chat-message-container:nth-child(${mid})`);
        
        if (!el) { high = mid - 1; continue; }

        const rect = await el.getBoundingClientRect();
        
        if (rect.top <= centerLine && rect.bottom >= centerLine) { return mid; }

        if (rect.top > centerLine) {
            low = mid + 1;
            closestIndex = mid; 
        } else {
            high = mid - 1;
        }
    }
    return closestIndex;
  };

  const getSmartCurrentIndex = async (rootDoc) => {
      if (cachedIndex !== -1) {
          const el = await rootDoc.querySelector(`.flex-col-reverse > .chat-message-container:nth-child(${cachedIndex})`);
          if (el) {
              const rect = await el.getBoundingClientRect();
              const centerLine = window.innerHeight / 2;
              if (rect.top <= centerLine && rect.bottom >= centerLine) {
                  return cachedIndex;
              }
          }
      }
      const newIndex = await binarySearchIndex(rootDoc);
      cachedIndex = newIndex; 
      return newIndex;
  };

  const ensureInit = async () => {
    if (!isMobileFixApplied) {
      await applyMobileFix();
      isMobileFixApplied = true;
    }
  };

  const getUserChatIndices = async () => {
    try {
      const db = await Risuai.getDatabase();
      const charIdx = await Risuai.getCurrentCharacterIndex();
      const chatListIdx = await Risuai.getCurrentChatIndex();
      if (!db || charIdx === -1 || chatListIdx === -1) return [];
      const character = db.characters[charIdx];
      const chatData = character.chats[chatListIdx];
      const messages = Array.isArray(chatData) ? chatData : (chatData?.message || []);
      const indices = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user') indices.push(i);
      }
      return indices;
    } catch (e) { return []; }
  };

  const buildChatIndexMap = async (rootDoc) => {
    try {
      const container = await rootDoc.querySelector('.flex-col-reverse');
      if (!container) return null;
      const html = await container.getInnerHTML();
      if (!html) return null;
      const matches = [...html.matchAll(/data-chat-index="(-?\d+)"/g)];
      const map = {};
      for (let i = 0; i < matches.length; i++) {
        map[i + 1] = parseInt(matches[i][1], 10);
      }
      return map;
    } catch (e) { return null; }
  };

  const isUserMessage = (nthIndex, chatIndexMap, userIndicesSet) => {
    if (!chatIndexMap || !userIndicesSet) return false;
    const chatIdx = chatIndexMap[nthIndex];
    if (chatIdx === undefined) return false;
    return userIndicesSet.has(chatIdx);
  };

  const handleUp = async () => {
    const now = Date.now();
    if (now - lastUpClickTime < DEBOUNCE_TIME) return; 
    lastUpClickTime = now;
    if(!isMobileFixApplied) await ensureInit();

    const singleClickUp = async () => {
      upTimer = null;
      const rootDoc = await Risuai.getRootDocument();
      const currentIndex = await getSmartCurrentIndex(rootDoc);
      const all = await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container');
      const totalCount = all.length;
      
      if (currentIndex !== -1) {
        let targetIndex = currentIndex + 1; 
        if (targetIndex > totalCount) targetIndex = totalCount;
        if (targetIndex <= totalCount) {
             const currentMsg = await rootDoc.querySelector(`.flex-col-reverse > .chat-message-container:nth-child(${currentIndex})`);
             if (currentMsg) {
                 const currentRect = await currentMsg.getBoundingClientRect();
                 if (currentRect.top > -20 && currentRect.top < 50) { } else if (currentRect.top < -20) { targetIndex = currentIndex; }
             }
        }
        const targetMsg = await rootDoc.querySelector(`.flex-col-reverse > .chat-message-container:nth-child(${targetIndex})`);
        if (targetMsg) {
            if (outputOnly) {
              const userIndices = await getUserChatIndices();
              const userIndicesSet = new Set(userIndices);
              const chatIndexMap = await buildChatIndexMap(rootDoc);
              while (targetIndex <= totalCount && isUserMessage(targetIndex, chatIndexMap, userIndicesSet)) { targetIndex++; }
              if (targetIndex > totalCount) return;
              const skipTarget = await rootDoc.querySelector(`.flex-col-reverse > .chat-message-container:nth-child(${targetIndex})`);
              if (skipTarget) {
                await skipTarget.scrollIntoView({ block: 'start', behavior: 'smooth' });
                cachedIndex = targetIndex;
              }
            } else {
              await targetMsg.scrollIntoView({ block: 'start', behavior: 'smooth' });
              cachedIndex = targetIndex; 
            }
        }
      }
    };

    try {
      if (buttonMode === 'dblclick' && upTimer) {
        clearTimeout(upTimer);
        upTimer = null;
        
        const rootDoc = await Risuai.getRootDocument();
        const scrollToFirstRecursive = async () => {
            const firstMsg = await rootDoc.querySelector('[data-chat-index="-1"]');
            if (firstMsg) {
                await firstMsg.scrollIntoView({ block: 'start', behavior: 'smooth' });
                const all = await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container');
                cachedIndex = all.length;
            } else {
                const oldestMsg = await rootDoc.querySelector('.flex-col-reverse > .chat-message-container:last-child');
                const beforeCount = (await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container')).length;
                if (oldestMsg) {
                    await oldestMsg.scrollIntoView({ block: 'start', behavior: 'smooth' });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    const afterCount = (await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container')).length;
                    if (afterCount >= beforeCount) await scrollToFirstRecursive();
                }
            }
        };
        await scrollToFirstRecursive();
      } else if (buttonMode === 'dblclick') {
        upTimer = setTimeout(singleClickUp, CLICK_DELAY);
      } else {
        await singleClickUp();
      }
    } catch (e) {}
  };

  const handleDown = async () => {
    const now = Date.now();
    if (now - lastDownClickTime < DEBOUNCE_TIME) return; 
    lastDownClickTime = now;
    if(!isMobileFixApplied) await ensureInit();

    const singleClickDown = async () => {
      downTimer = null;
      const rootDoc = await Risuai.getRootDocument();
      const currentIndex = await getSmartCurrentIndex(rootDoc);
      if (currentIndex !== -1) {
        let targetIndex = currentIndex - 1;
        if (targetIndex >= 1) {
          const targetMsg = await rootDoc.querySelector(`.flex-col-reverse > .chat-message-container:nth-child(${targetIndex})`);
          if (targetMsg) {
            const rect = await targetMsg.getBoundingClientRect();
            if (rect.top > -10 && rect.top < 10) targetIndex--;
          }
        }
        if (targetIndex >= 1) {
          const finalTarget = await rootDoc.querySelector(`.flex-col-reverse > .chat-message-container:nth-child(${targetIndex})`);
          if (finalTarget) {
              if (outputOnly) {
                const userIndices = await getUserChatIndices();
                const userIndicesSet = new Set(userIndices);
                const chatIndexMap = await buildChatIndexMap(rootDoc);
                while (targetIndex >= 1 && isUserMessage(targetIndex, chatIndexMap, userIndicesSet)) { targetIndex--; }
                if (targetIndex < 1) {
                  const textarea = await rootDoc.querySelector('textarea');
                  if(textarea) await textarea.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  cachedIndex = 0;
                  return;
                }
                const skipTarget = await rootDoc.querySelector(`.flex-col-reverse > .chat-message-container:nth-child(${targetIndex})`);
                if (skipTarget) {
                  await skipTarget.scrollIntoView({ block: 'start', behavior: 'smooth' });
                  cachedIndex = targetIndex;
                }
              } else {
                await finalTarget.scrollIntoView({ block: 'start', behavior: 'smooth' });
                cachedIndex = targetIndex; 
              }
          }
        } else {
          const newestMsg = await rootDoc.querySelector('.flex-col-reverse > .chat-message-container:first-child');
          if (newestMsg) {
              await newestMsg.scrollIntoView({ block: 'end', behavior: 'smooth' });
          } else {
              const textarea = await rootDoc.querySelector('textarea');
              if(textarea) await textarea.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
          cachedIndex = 1;
        }
      }
    };

    try {
      if (buttonMode === 'dblclick' && downTimer) {
        clearTimeout(downTimer);
        downTimer = null;
        const rootDoc = await Risuai.getRootDocument();
        const scrollToBottomRecursive = async () => {
            const allBefore = await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container');
            const beforeCount = allBefore.length;
            const newestMessage = await rootDoc.querySelector('.flex-col-reverse > .chat-message-container:first-child');
            const textarea = await rootDoc.querySelector('textarea');
            if (newestMessage) {
                await newestMessage.scrollIntoView({ block: 'end', behavior: 'smooth' });
                await new Promise(resolve => setTimeout(resolve, 1000));
                const allAfter = await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container');
                const afterCount = allAfter.length;
                if (afterCount > beforeCount) await scrollToBottomRecursive();
                else cachedIndex = 1;
            } else if (textarea) {
                await textarea.scrollIntoView({ block: 'center', behavior: 'smooth' });
                cachedIndex = 0;
            }
        };
        await scrollToBottomRecursive();
      } else if (buttonMode === 'dblclick') {
        downTimer = setTimeout(singleClickDown, CLICK_DELAY);
      } else {
        await singleClickDown();
      }
    } catch (e) {}
  };

  const handleScrollToTop = async () => {
    try {
      const rootDoc = await Risuai.getRootDocument();
      const scrollToFirstRecursive = async () => {
        const firstMsg = await rootDoc.querySelector('[data-chat-index="-1"]');
        if (firstMsg) {
          await firstMsg.scrollIntoView({ block: 'start', behavior: 'smooth' });
          const all = await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container');
          cachedIndex = all.length;
        } else {
          const oldestMsg = await rootDoc.querySelector('.flex-col-reverse > .chat-message-container:last-child');
          const beforeCount = (await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container')).length;
          if (oldestMsg) {
            await oldestMsg.scrollIntoView({ block: 'start', behavior: 'smooth' });
            await new Promise(resolve => setTimeout(resolve, 1000));
            const afterCount = (await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container')).length;
            if (afterCount >= beforeCount) await scrollToFirstRecursive();
          }
        }
      };
      await scrollToFirstRecursive();
    } catch (e) {}
  };

  const handleScrollToBottom = async () => {
    try {
      const rootDoc = await Risuai.getRootDocument();
      const scrollToBottomRecursive = async () => {
        const allBefore = await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container');
        const beforeCount = allBefore.length;
        const newestMessage = await rootDoc.querySelector('.flex-col-reverse > .chat-message-container:first-child');
        const textarea = await rootDoc.querySelector('textarea');
        if (newestMessage) {
          await newestMessage.scrollIntoView({ block: 'end', behavior: 'smooth' });
          await new Promise(resolve => setTimeout(resolve, 1000));
          const allAfter = await rootDoc.querySelectorAll('.flex-col-reverse > .chat-message-container');
          const afterCount = allAfter.length;
          if (afterCount > beforeCount) await scrollToBottomRecursive();
          else cachedIndex = 1;
        } else if (textarea) {
          await textarea.scrollIntoView({ block: 'center', behavior: 'smooth' });
          cachedIndex = 0;
        }
      };
      await scrollToBottomRecursive();
    } catch (e) {}
  };

  const checkChatScreen = async () => {
    try {
      const rootDoc = await Risuai.getRootDocument();
      const chatContainer = await rootDoc.querySelector('.flex-col-reverse');
      const isOnChat = !!chatContainer;
      if (isOnChat === lastChatScreenState) return;
      lastChatScreenState = isOnChat;
      if (isOnChat) {
        if (alwaysShow && !widgetElement) await toggleWidget(true);
        else if (widgetElement) await widgetElement.setStyle('display', 'flex');
      } else {
        if (widgetElement) await widgetElement.setStyle('display', 'none');
      }
    } catch (e) {}
  };

  const startChatObserver = async () => {
    if (domObserver) return;
    try {
      const rootDoc = await Risuai.getRootDocument();
      const body = await rootDoc.querySelector('body');
      domObserver = await Risuai.createMutationObserver(async () => {
        if (observerTimer) clearTimeout(observerTimer);
        observerTimer = setTimeout(checkChatScreen, 300);
      });
      await domObserver.observe(body, { childList: true, subtree: true });
    } catch (e) {}
  };

  const toggleWidget = async (forceShow = false) => {
    try {
        const rootDoc = await Risuai.getRootDocument();
        const body = await rootDoc.querySelector('body');
        const existingWidget = await rootDoc.querySelector(`[${WIDGET_ATTR_KEY}="${WIDGET_ATTR_VAL}"]`);

        if (existingWidget) {
            await existingWidget.remove();
            widgetElement = null;
            if(globalPointerMoveId) await body.removeEventListener('pointermove', globalPointerMoveId);
            if(globalPointerUpId) await body.removeEventListener('pointerup', globalPointerUpId);
            globalPointerMoveId = null;
            globalPointerUpId = null;
            
            if (!forceShow) return; 
        }

        const storedTheme = await Risuai.pluginStorage.getItem(STORAGE_KEY_THEME);
        const isDark = (storedTheme === 'dark');

        const themeConfig = {
            white: {
                handle: 'rgba(255, 255, 255, 0.3)',
                handleActive: 'rgba(255, 255, 255, 0.8)',
                btnBg: 'rgba(255, 255, 255, 0.05)',
                btnBorder: 'rgba(255, 255, 255, 0.2)',
                btnColor: 'rgba(255, 255, 255, 0.9)'
            },
            dark: {
                handle: 'rgba(0, 0, 0, 0.4)',
                handleActive: 'rgba(0, 0, 0, 0.8)',
                btnBg: 'rgba(0, 0, 0, 0.3)',
                btnBorder: 'rgba(0, 0, 0, 0.3)',
                btnColor: 'rgba(0, 0, 0, 0.8)'
            }
        };

        const currentTheme = isDark ? themeConfig.dark : themeConfig.white;
        const sz = sizeConfig[widgetSize] || sizeConfig.default;

        const container = await rootDoc.createElement('div');
        await container.setAttribute(WIDGET_ATTR_KEY, WIDGET_ATTR_VAL);
        
        const containerStyle = `
            position: fixed;
            bottom: 100px;
            right: 20px;
            width: ${sz.container}px !important;
            height: auto !important;
            display: flex;
            flex-direction: column;
            gap: ${sz.gap}px;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            padding: ${sz.pad}px;
            padding-top: ${sz.padTop}px;
            border-radius: ${sz.radius}px;
            background-color: rgba(0, 0, 0, 0);
            box-shadow: 0 4px 6px rgba(0,0,0,0);
            user-select: none;
            -webkit-user-select: none;
            cursor: default;
            touch-action: none;
        `;
        await container.setStyleAttribute(containerStyle);

        const handleStyle = `
            width: ${sz.handleW}px;
            height: ${sz.handleH}px;
            background-color: ${currentTheme.handle};
            border-radius: ${sz.handleH / 2}px;
            cursor: move;
            margin-bottom: ${sz.handleMB}px;
            flex-shrink: 0;
            pointer-events: none; 
            transition: background-color 0.2s;
        `;
        
        const dragHandle = await rootDoc.createElement('div');
        await dragHandle.setStyleAttribute(handleStyle);

        const btnStyle = `
            width: ${sz.btn}px !important; 
            height: ${sz.btn}px !important; 
            border-radius: 50%; 
            border: 1px solid ${currentTheme.btnBorder}; 
            background: ${currentTheme.btnBg}; 
            color: ${currentTheme.btnColor};
            display: flex; 
            align-items: center; 
            justify-content: center;
            flex-shrink: 0;
            pointer-events: none; 
            transition: background 0.2s;
        `;
        
        const iconStyle = `pointer-events: none; width: ${sz.icon}px; height: ${sz.icon}px;`;

        const upBtn = await rootDoc.createElement('div');
        await upBtn.setStyleAttribute(btnStyle);
        await upBtn.setInnerHTML(`<svg style="${iconStyle}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>`);
        
        const downBtn = await rootDoc.createElement('div');
        await downBtn.setStyleAttribute(btnStyle);
        await downBtn.setInnerHTML(`<svg style="${iconStyle}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`);

        let topBtn = null;
        let bottomBtn = null;
        if (buttonMode === 'fourBtn') {
          topBtn = await rootDoc.createElement('div');
          await topBtn.setStyleAttribute(btnStyle);
          await topBtn.setInnerHTML(`<svg style="${iconStyle}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 11-6-6-6 6"/><path d="m18 17-6-6-6 6"/></svg>`);

          bottomBtn = await rootDoc.createElement('div');
          await bottomBtn.setStyleAttribute(btnStyle);
          await bottomBtn.setInnerHTML(`<svg style="${iconStyle}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 7 6 6 6-6"/><path d="m6 13 6 6 6-6"/></svg>`);
        }

        handleRef = dragHandle;
        upBtnRef = upBtn;
        downBtnRef = downBtn;
        topBtnRef = topBtn;
        bottomBtnRef = bottomBtn;

        await container.appendChild(dragHandle);
        if (topBtn) await container.appendChild(topBtn);
        await container.appendChild(upBtn);
        await container.appendChild(downBtn);
        if (bottomBtn) await container.appendChild(bottomBtn);

        await body.appendChild(container);
        widgetElement = container;

        await container.addEventListener('click', async (e) => {
            if (isDragging) return;
            const clientX = e.clientX;
            const clientY = e.clientY;
            if (clientX === undefined || clientY === undefined || !upBtnRef || !downBtnRef) return;
            if (topBtnRef) {
                const topRect = await topBtnRef.getBoundingClientRect();
                if (clientX >= topRect.left && clientX <= topRect.right &&
                    clientY >= topRect.top && clientY <= topRect.bottom) {
                    await handleScrollToTop();
                    return;
                }
            }
            const upRect = await upBtnRef.getBoundingClientRect();
            const downRect = await downBtnRef.getBoundingClientRect();
            if (clientX >= upRect.left && clientX <= upRect.right &&
                clientY >= upRect.top && clientY <= upRect.bottom) {
                await handleUp();
                return;
            }
            if (clientX >= downRect.left && clientX <= downRect.right &&
                clientY >= downRect.top && clientY <= downRect.bottom) {
                await handleDown();
                return;
            }
            if (bottomBtnRef) {
                const bottomRect = await bottomBtnRef.getBoundingClientRect();
                if (clientX >= bottomRect.left && clientX <= bottomRect.right &&
                    clientY >= bottomRect.top && clientY <= bottomRect.bottom) {
                    await handleScrollToBottom();
                    return;
                }
            }
        });

        try {
            await container.addEventListener('pointerdown', async (e) => {
                if (e.button !== 0 && e.button !== -1) return;
                const clientX = e.clientX;
                const clientY = e.clientY;
                if (clientX === undefined || clientY === undefined || !dragHandle) return;

                const handleRect = await dragHandle.getBoundingClientRect();
                const isInsideHandle = 
                    clientX >= handleRect.left && 
                    clientX <= handleRect.right &&
                    clientY >= handleRect.top && 
                    clientY <= handleRect.bottom;

                if (!isInsideHandle) return; 

                isDragging = true;
                const rect = await container.getBoundingClientRect();
                dragShiftX = clientX - rect.left;
                dragShiftY = clientY - rect.top;
                
                await dragHandle.setStyle('backgroundColor', currentTheme.handleActive);

                if(globalPointerMoveId) await body.removeEventListener('pointermove', globalPointerMoveId);
                if(globalPointerUpId) await body.removeEventListener('pointerup', globalPointerUpId);

                globalPointerMoveId = await body.addEventListener('pointermove', async (ev) => {
                    if (!isDragging || !widgetElement) return;
                    if(ev.preventDefault) ev.preventDefault();
                    const newX = ev.clientX - dragShiftX;
                    const newY = ev.clientY - dragShiftY;
                    await widgetElement.setStyle('bottom', 'auto');
                    await widgetElement.setStyle('right', 'auto');
                    await widgetElement.setStyle('left', `${newX}px`);
                    await widgetElement.setStyle('top', `${newY}px`);
                });

                globalPointerUpId = await body.addEventListener('pointerup', async () => {
                    if (isDragging) {
                        isDragging = false;
                        if (dragHandle) await dragHandle.setStyle('backgroundColor', currentTheme.handle); 
                    }
                    if(globalPointerMoveId) await body.removeEventListener('pointermove', globalPointerMoveId);
                    if(globalPointerUpId) await body.removeEventListener('pointerup', globalPointerUpId);
                    globalPointerMoveId = null;
                    globalPointerUpId = null;
                });
            });
        } catch(dragErr) {}

    } catch (e) {}
  };

  const showSettingsPanel = async () => {
    const rootDoc = await Risuai.getRootDocument();
    const body = await rootDoc.querySelector('body');

    const existing = await rootDoc.querySelector(`[${SETTINGS_ATTR_KEY}]`);
    if (existing) {
      await existing.remove();
      return;
    }

    const currentTheme = await Risuai.pluginStorage.getItem(STORAGE_KEY_THEME) || 'white';
    const modeDisplayMap = {
      'off': { label: 'OFF', bg: 'rgba(244,67,54,0.3)' },
      'dblclick': { label: '더블클릭', bg: 'rgba(76,175,80,0.3)' },
      'fourBtn': { label: '4버튼', bg: 'rgba(33,150,243,0.3)' }
    };
    let currentMode = buttonMode;

    const overlay = await rootDoc.createElement('div');
    await overlay.setAttribute(SETTINGS_ATTR_KEY, 'panel');
    await overlay.setStyleAttribute(`
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;
      z-index: 99999; touch-action: none;
    `);

    const panel = await rootDoc.createElement('div');
    await panel.setStyleAttribute(`
      background: #2a2a2a; border-radius: 16px; padding: 24px;
      min-width: 280px; max-width: 340px; color: #fff;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    `);

    const title = await rootDoc.createElement('div');
    await title.setStyleAttribute(`font-size: 18px; font-weight: 600; margin-bottom: 4px; text-align: center;`);
    await title.setInnerHTML('ScrollPlus 설정');
    await panel.appendChild(title);

    const versionBtn = await rootDoc.createElement('div');
    await versionBtn.setStyleAttribute(`
      font-size: 11px; color: #888; text-align: center; margin-bottom: 16px;
      cursor: pointer; pointer-events: none; transition: color 0.2s;
    `);
    await versionBtn.setInnerHTML('v1.0.1 · 패치 내역 보기');
    await panel.appendChild(versionBtn);

    const themeRow = await rootDoc.createElement('div');
    await themeRow.setStyleAttribute(`
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 12px; padding: 12px 14px; background: rgba(255,255,255,0.08);
      border-radius: 10px; pointer-events: none;
    `);
    const themeLabel = await rootDoc.createElement('span');
    await themeLabel.setStyleAttribute(`font-size: 14px; color: #ccc; pointer-events: none;`);
    await themeLabel.setInnerHTML('위젯 테마');
    const themeToggle = await rootDoc.createElement('div');
    await themeToggle.setStyleAttribute(`
      padding: 6px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
      background: ${currentTheme === 'white' ? 'rgba(255,255,255,0.2)' : 'rgba(60,60,60,0.8)'};
      color: #fff; border: 1px solid rgba(255,255,255,0.15); pointer-events: none;
    `);
    await themeToggle.setInnerHTML(currentTheme === 'white' ? 'White' : 'Dark');
    await themeRow.appendChild(themeLabel);
    await themeRow.appendChild(themeToggle);
    await panel.appendChild(themeRow);

    const dblRow = await rootDoc.createElement('div');
    await dblRow.setStyleAttribute(`
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 12px; padding: 12px 14px; background: rgba(255,255,255,0.08);
      border-radius: 10px; pointer-events: none;
    `);
    const dblLabel = await rootDoc.createElement('span');
    await dblLabel.setStyleAttribute(`font-size: 14px; color: #ccc; pointer-events: none;`);
    await dblLabel.setInnerHTML('스크롤 모드');
    const dblToggle = await rootDoc.createElement('div');
    await dblToggle.setStyleAttribute(`
      padding: 6px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
      background: ${modeDisplayMap[currentMode].bg};
      color: #fff; border: 1px solid rgba(255,255,255,0.15); pointer-events: none;
    `);
    await dblToggle.setInnerHTML(modeDisplayMap[currentMode].label);
    await dblRow.appendChild(dblLabel);
    await dblRow.appendChild(dblToggle);
    await panel.appendChild(dblRow);

    let isAlwaysShow = alwaysShow;
    const alwaysRow = await rootDoc.createElement('div');
    await alwaysRow.setStyleAttribute(`
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 12px; padding: 12px 14px; background: rgba(255,255,255,0.08);
      border-radius: 10px; pointer-events: none;
    `);
    const alwaysLabel = await rootDoc.createElement('span');
    await alwaysLabel.setStyleAttribute(`font-size: 14px; color: #ccc; pointer-events: none;`);
    await alwaysLabel.setInnerHTML('항상 보이기');
    const alwaysToggle = await rootDoc.createElement('div');
    await alwaysToggle.setStyleAttribute(`
      padding: 6px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
      background: ${isAlwaysShow ? 'rgba(76,175,80,0.3)' : 'rgba(244,67,54,0.3)'};
      color: #fff; border: 1px solid rgba(255,255,255,0.15); pointer-events: none;
    `);
    await alwaysToggle.setInnerHTML(isAlwaysShow ? 'ON' : 'OFF');
    await alwaysRow.appendChild(alwaysLabel);
    await alwaysRow.appendChild(alwaysToggle);
    await panel.appendChild(alwaysRow);

    const sizeDisplayMap = {
      'small': { label: '작게', bg: 'rgba(255,152,0,0.3)' },
      'default': { label: '기본', bg: 'rgba(76,175,80,0.3)' },
      'large': { label: '크게', bg: 'rgba(33,150,243,0.3)' }
    };
    let currentSizeSetting = widgetSize;
    const sizeRow = await rootDoc.createElement('div');
    await sizeRow.setStyleAttribute(`
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 20px; padding: 12px 14px; background: rgba(255,255,255,0.08);
      border-radius: 10px; pointer-events: none;
    `);
    const sizeLabel = await rootDoc.createElement('span');
    await sizeLabel.setStyleAttribute(`font-size: 14px; color: #ccc; pointer-events: none;`);
    await sizeLabel.setInnerHTML('위젯 크기');
    const sizeToggle = await rootDoc.createElement('div');
    await sizeToggle.setStyleAttribute(`
      padding: 6px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
      background: ${sizeDisplayMap[currentSizeSetting].bg};
      color: #fff; border: 1px solid rgba(255,255,255,0.15); pointer-events: none;
    `);
    await sizeToggle.setInnerHTML(sizeDisplayMap[currentSizeSetting].label);
    await sizeRow.appendChild(sizeLabel);
    await sizeRow.appendChild(sizeToggle);
    await panel.appendChild(sizeRow);

    let isOutputOnly = outputOnly;
    const outputRow = await rootDoc.createElement('div');
    await outputRow.setStyleAttribute(`
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 20px; padding: 12px 14px; background: rgba(255,255,255,0.08);
      border-radius: 10px; pointer-events: none;
    `);
    const outputLabel = await rootDoc.createElement('span');
    await outputLabel.setStyleAttribute(`font-size: 14px; color: #ccc; pointer-events: none;`);
    await outputLabel.setInnerHTML('아웃풋만 이동');
    const outputToggle = await rootDoc.createElement('div');
    await outputToggle.setStyleAttribute(`
      padding: 6px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
      background: ${isOutputOnly ? 'rgba(76,175,80,0.3)' : 'rgba(244,67,54,0.3)'};
      color: #fff; border: 1px solid rgba(255,255,255,0.15); pointer-events: none;
    `);
    await outputToggle.setInnerHTML(isOutputOnly ? 'ON' : 'OFF');
    await outputRow.appendChild(outputLabel);
    await outputRow.appendChild(outputToggle);
    await panel.appendChild(outputRow);

    const closeBtn = await rootDoc.createElement('div');
    await closeBtn.setStyleAttribute(`
      text-align: center; padding: 10px; border-radius: 10px;
      background: rgba(255,255,255,0.1); color: #aaa; font-size: 14px;
      pointer-events: none;
    `);
    await closeBtn.setInnerHTML('닫기');
    await panel.appendChild(closeBtn);

    const patchOverlay = await rootDoc.createElement('div');
    await patchOverlay.setStyleAttribute(`
      display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6); z-index: 100000;
      justify-content: center; align-items: center; touch-action: none;
    `);
    const patchCard = await rootDoc.createElement('div');
    await patchCard.setStyleAttribute(`
      background: #1e1e1e; border: 1px solid #333; border-radius: 12px;
      width: 90%; max-width: 340px; max-height: 60vh; display: flex;
      flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    `);
    const patchHeader = await rootDoc.createElement('div');
    await patchHeader.setStyleAttribute(`
      padding: 14px 18px; border-bottom: 1px solid #333;
      display: flex; justify-content: space-between; align-items: center;
    `);
    const patchTitle = await rootDoc.createElement('span');
    await patchTitle.setStyleAttribute(`font-size: 14px; color: #e0e0e0; font-weight: 600;`);
    await patchTitle.setInnerHTML('↕️ 패치 내역');
    const patchCloseBtn = await rootDoc.createElement('span');
    await patchCloseBtn.setStyleAttribute(`color: #888; font-size: 16px; pointer-events: none; cursor: pointer; padding: 2px 6px;`);
    await patchCloseBtn.setInnerHTML('✕');
    await patchHeader.appendChild(patchTitle);
    await patchHeader.appendChild(patchCloseBtn);
    await patchCard.appendChild(patchHeader);
    const patchBody = await rootDoc.createElement('div');
    await patchBody.setStyleAttribute(`
      padding: 16px 18px; overflow-y: auto; font-size: 12px; color: #ccc; line-height: 1.7;
    `);
    await patchBody.setInnerHTML(`
      <div style="color:#4ecca3; font-weight:600; margin-bottom:6px;">v1.0.1</div>
      <ul style="margin:0 0 12px 0; padding-left:18px;">
        <li>누락한 mutation observer 추가</li>
      </ul>
      <div style="color:#4ecca3; font-weight:600; margin-bottom:6px;">v1.0.0</div>
      <ul style="margin:0 0 12px 0; padding-left:18px;">
        <li>QuickUp에서 ScrollPlus로 변경</li>
        <li>스크롤 모드 3가지 지원 (OFF / 더블클릭 / 4버튼)</li>
        <li>4버튼 모드: 맨 위로·맨 아래로 전용 버튼 추가</li>
        <li>항상 보이기 토글 추가</li>
        <li>위젯 크기 3단계 (작게 / 기본 / 크게) 설정</li>
        <li>자동 업데이트 및 패치 내역 확인 기능 추가</li>
        <li>아웃풋만 이동 토글 추가</li>
      </ul>
      <div style="color:#888; font-size:11px;">이전 버전은 아카챈 참고</div>
    `);
    await patchCard.appendChild(patchBody);
    await patchOverlay.appendChild(patchCard);
    await body.appendChild(patchOverlay);

    await overlay.appendChild(panel);
    await body.appendChild(overlay);

    await overlay.addEventListener('click', async (e) => {
      const cx = e.clientX;
      const cy = e.clientY;
      if (cx === undefined || cy === undefined) return;

      const themeRect = await themeRow.getBoundingClientRect();
      if (cx >= themeRect.left && cx <= themeRect.right && cy >= themeRect.top && cy <= themeRect.bottom) {
        const cur = await Risuai.pluginStorage.getItem(STORAGE_KEY_THEME) || 'white';
        const next = cur === 'white' ? 'dark' : 'white';
        await Risuai.pluginStorage.setItem(STORAGE_KEY_THEME, next);
        await themeToggle.setInnerHTML(next === 'white' ? 'White' : 'Dark');
        await themeToggle.setStyle('background', next === 'white' ? 'rgba(255,255,255,0.2)' : 'rgba(60,60,60,0.8)');
        if (widgetElement) await toggleWidget(true);
        return;
      }

      const dblRect = await dblRow.getBoundingClientRect();
      if (cx >= dblRect.left && cx <= dblRect.right && cy >= dblRect.top && cy <= dblRect.bottom) {
        const modeOrder = ['off', 'dblclick', 'fourBtn'];
        const currentIdx = modeOrder.indexOf(currentMode);
        currentMode = modeOrder[(currentIdx + 1) % modeOrder.length];
        buttonMode = currentMode;
        await Risuai.pluginStorage.setItem(STORAGE_KEY_DBLCLICK, currentMode);
        const display = modeDisplayMap[currentMode];
        await dblToggle.setInnerHTML(display.label);
        await dblToggle.setStyle('background', display.bg);
        if (widgetElement) await toggleWidget(true);
        return;
      }

      const alwaysRect = await alwaysRow.getBoundingClientRect();
      if (cx >= alwaysRect.left && cx <= alwaysRect.right && cy >= alwaysRect.top && cy <= alwaysRect.bottom) {
        isAlwaysShow = !isAlwaysShow;
        alwaysShow = isAlwaysShow;
        await Risuai.pluginStorage.setItem(STORAGE_KEY_ALWAYS_SHOW, isAlwaysShow ? 'true' : 'false');
        await alwaysToggle.setInnerHTML(isAlwaysShow ? 'ON' : 'OFF');
        await alwaysToggle.setStyle('background', isAlwaysShow ? 'rgba(76,175,80,0.3)' : 'rgba(244,67,54,0.3)');
        return;
      }

      const sizeRect = await sizeRow.getBoundingClientRect();
      if (cx >= sizeRect.left && cx <= sizeRect.right && cy >= sizeRect.top && cy <= sizeRect.bottom) {
        const sizeOrder = ['small', 'default', 'large'];
        const sIdx = sizeOrder.indexOf(currentSizeSetting);
        currentSizeSetting = sizeOrder[(sIdx + 1) % sizeOrder.length];
        widgetSize = currentSizeSetting;
        await Risuai.pluginStorage.setItem(STORAGE_KEY_WIDGET_SIZE, currentSizeSetting);
        const sd = sizeDisplayMap[currentSizeSetting];
        await sizeToggle.setInnerHTML(sd.label);
        await sizeToggle.setStyle('background', sd.bg);
        if (widgetElement) await toggleWidget(true);
        return;
      }

      const outputRect = await outputRow.getBoundingClientRect();
      if (cx >= outputRect.left && cx <= outputRect.right && cy >= outputRect.top && cy <= outputRect.bottom) {
        isOutputOnly = !isOutputOnly;
        outputOnly = isOutputOnly;
        await Risuai.pluginStorage.setItem(STORAGE_KEY_OUTPUT_ONLY, isOutputOnly ? 'true' : 'false');
        await outputToggle.setInnerHTML(isOutputOnly ? 'ON' : 'OFF');
        await outputToggle.setStyle('background', isOutputOnly ? 'rgba(76,175,80,0.3)' : 'rgba(244,67,54,0.3)');
        return;
      }

      const closeRect = await closeBtn.getBoundingClientRect();
      if (cx >= closeRect.left && cx <= closeRect.right && cy >= closeRect.top && cy <= closeRect.bottom) {
        await patchOverlay.remove();
        await overlay.remove();
        return;
      }

      const versionRect = await versionBtn.getBoundingClientRect();
      if (cx >= versionRect.left && cx <= versionRect.right && cy >= versionRect.top && cy <= versionRect.bottom) {
        await patchOverlay.setStyle('display', 'flex');
        return;
      }

      const panelRect = await panel.getBoundingClientRect();
      if (cx < panelRect.left || cx > panelRect.right || cy < panelRect.top || cy > panelRect.bottom) {
        await patchOverlay.remove();
        await overlay.remove();
        return;
      }
    });

    await patchOverlay.addEventListener('click', async (e) => {
      const px = e.clientX;
      const py = e.clientY;
      if (px === undefined || py === undefined) return;
      const patchCloseRect = await patchCloseBtn.getBoundingClientRect();
      if (px >= patchCloseRect.left && px <= patchCloseRect.right && py >= patchCloseRect.top && py <= patchCloseRect.bottom) {
        await patchOverlay.setStyle('display', 'none');
        return;
      }
      const cardRect = await patchCard.getBoundingClientRect();
      if (px < cardRect.left || px > cardRect.right || py < cardRect.top || py > cardRect.bottom) {
        await patchOverlay.setStyle('display', 'none');
        return;
      }
    });
  };

  try {
    const storedDblClick = await Risuai.pluginStorage.getItem(STORAGE_KEY_DBLCLICK);
    if (storedDblClick === 'fourBtn') {
      buttonMode = 'fourBtn';
    } else if (storedDblClick === 'false' || storedDblClick === 'off') {
      buttonMode = 'off';
    } else {
      buttonMode = 'dblclick';
    }

    const storedAlwaysShow = await Risuai.pluginStorage.getItem(STORAGE_KEY_ALWAYS_SHOW);
    alwaysShow = storedAlwaysShow === 'true';

    const storedSize = await Risuai.pluginStorage.getItem(STORAGE_KEY_WIDGET_SIZE);
    if (storedSize === 'small' || storedSize === 'large') {
      widgetSize = storedSize;
    } else {
      widgetSize = 'default';
    }

    const storedOutputOnly = await Risuai.pluginStorage.getItem(STORAGE_KEY_OUTPUT_ONLY);
    outputOnly = storedOutputOnly === 'true';

    if (alwaysShow) {
      await toggleWidget(true);
    }

    await startChatObserver();
    await checkChatScreen();

    await Risuai.registerButton({
      name: 'ScrollPlus',
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>`,
      iconType: 'html',
      location: 'chat'
    }, async () => {
      await toggleWidget();
    });

    await Risuai.registerSetting(
      'ScrollPlus 설정',
      async () => {
        await showSettingsPanel();
      },
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>`,
      'html'
    );

    Risuai.onUnload(async () => {
      try {
        const rootDoc = await Risuai.getRootDocument();
        const w = await rootDoc.querySelector(`[${WIDGET_ATTR_KEY}="${WIDGET_ATTR_VAL}"]`);
        if (w) await w.remove();
        const s = await rootDoc.querySelector(`[${SETTINGS_ATTR_KEY}]`);
        if (s) await s.remove();
        
        const body = await rootDoc.querySelector('body');
        if(globalPointerMoveId) await body.removeEventListener('pointermove', globalPointerMoveId);
        if(globalPointerUpId) await body.removeEventListener('pointerup', globalPointerUpId);
        if (domObserver) {
          try { await domObserver.disconnect(); } catch(e) {}
          domObserver = null;
        }
        if (observerTimer) {
          clearTimeout(observerTimer);
          observerTimer = null;
        }
      } catch(e) {}
    });

  } catch (error) {}

})();