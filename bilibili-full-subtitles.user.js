// ==UserScript==
// @name         哔哩哔哩完整字幕
// @namespace    local.bilibili.transcript
// @version      1.2.0
// @description  在哔哩哔哩视频页阅读、搜索和复制当前分 P 的完整字幕。
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/*/video/*
// @run-at       document-idle
// @inject-into  auto
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const hostId = 'bilibili-full-subtitles';
  const api = 'https://api.bilibili.com';
  if (location.hostname !== 'www.bilibili.com' || document.getElementById(hostId)) return;

  function currentPage() {
    const match = location.pathname.match(/(?:^|\/)video\/(BV[0-9A-Za-z]+|av\d+)(?:\/|$)/i);
    if (!match) return null;
    const id = match[1];
    const isBv = id.slice(0, 2).toUpperCase() === 'BV';
    const part = Math.max(1, Number.parseInt(new URLSearchParams(location.search).get('p'), 10) || 1);
    return {
      key: `${id}:${part}`,
      idKey: isBv ? 'bvid' : 'aid',
      id: isBv ? `BV${id.slice(2)}` : id.slice(2),
      part,
    };
  }

  async function getJson(url, signal, credentials = 'include') {
    const request = new AbortController();
    const cancel = () => request.abort();
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });

    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      cancel();
    }, 12000);
    try {
      const response = await fetch(url, { credentials, signal: request.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (timedOut) throw new Error('请求超时');
      throw error;
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  }

  async function resolvePart(page, signal) {
    const initial = window.__INITIAL_STATE__?.videoData;
    if (String(initial?.[page.idKey]) === page.id) {
      const part = initial.pages?.find(item => Number(item.page) === page.part);
      if (part?.cid && initial.aid) return { cid: String(part.cid), aid: String(initial.aid) };
    }
    const url = new URL('/x/web-interface/view', api);
    url.searchParams.set(page.idKey, page.id);
    const result = await getJson(url, signal);
    const video = result.data;
    const part = video?.pages?.find(item => Number(item.page) === page.part);
    if (result.code !== 0 || !part?.cid || !video?.aid) throw new Error('无法识别当前分 P，请确认视频已加载。');
    return { cid: String(part.cid), aid: String(video.aid) };
  }

  function normalizeTracks(items) {
    const seen = new Set();
    return items.flatMap(track => {
      const address = track?.subtitle_url || track?.subtitle_url_v2;
      if (typeof address !== 'string' || !address) return [];
      let url;
      try {
        url = new URL(address, location.origin);
      } catch {
        return [];
      }
      if (url.protocol === 'http:') url.protocol = 'https:';
      if (url.protocol !== 'https:' || url.username || url.password ||
          !/(^|\.)(hdslb\.com|bilibili\.com)$/.test(url.hostname)) return [];
      const code = String(track.lan ?? '');
      const key = String(track.id_str || `${code}|${url.href}`);
      if (seen.has(key)) return [];
      seen.add(key);
      const source = code.startsWith('ai-') || Number(track.type) === 1 ? 'AI' : '投稿字幕';
      return [{ key, code, url, label: `${track.lan_doc || code || '未知语言'} · ${source}` }];
    });
  }

  function observedPlayerUrl(cid, aid) {
    for (const entry of performance.getEntriesByType('resource').reverse()) {
      const url = new URL(entry.name);
      if (url.origin === api && url.pathname === '/x/player/wbi/v2' &&
          url.searchParams.get('aid') === aid &&
          url.searchParams.get('cid') === cid) return url;
    }
    return null;
  }

  async function waitForPlayerUrl(cid, aid, signal) {
    // If the panel opens before the player is ready, give its metadata request time to appear.
    for (let attempt = 0; attempt < 8; attempt++) {
      const url = observedPlayerUrl(cid, aid);
      if (url || signal.aborted) return url;
      await new Promise(resolve => window.setTimeout(resolve, 150));
    }
    return observedPlayerUrl(cid, aid);
  }

  async function findTracks(page, signal) {
    const { cid, aid } = await resolvePart(page, signal);
    const classic = new URL('/x/player/v2', api);
    classic.searchParams.set('aid', aid);
    classic.searchParams.set('cid', cid);
    const observed = await waitForPlayerUrl(cid, aid, signal);
    let emptyList;
    let requestError;
    for (const url of [observed, classic].filter(Boolean)) {
      try {
        const response = await getJson(url, signal);
        if (response.code !== 0 || !response.data) {
          throw new Error(`B 站返回 ${response.code ?? '未知错误'}`);
        }
        if ((response.data.cid && String(response.data.cid) !== cid) ||
            (response.data.aid && String(response.data.aid) !== aid)) throw new Error('返回的视频或分 P 不一致');
        const raw = response.data.subtitle?.subtitles;
        const tracks = normalizeTracks(Array.isArray(raw) ? raw : []);
        if (tracks.length) return { tracks, message: '' };
        if (response.data.need_login_subtitle) {
          emptyList = '此分 P 的字幕需要登录 B 站后查看。';
        } else if (!emptyList) {
          emptyList = raw?.length ? '检测到字幕轨，但当前没有可读取的字幕地址。' : '当前分 P 没有可读取的字幕轨。';
        }
      } catch (error) {
        if (signal.aborted) throw error;
        requestError = error;
      }
    }
    if (emptyList) return { tracks: [], message: emptyList };
    throw requestError;
  }

  function parseCues(payload) {
    if (!Array.isArray(payload?.body)) throw new Error('字幕文件格式无法识别');
    return payload.body.flatMap(cue => {
      if (typeof cue?.content !== 'string' || !cue.content.trim()) return [];
      const start = Number(cue.from);
      return [{ start: cue.from != null && Number.isFinite(start) && start >= 0 ? start : null, text: cue.content }];
    });
  }

  function formatTime(seconds) {
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole / 60) % 60;
    const tail = `${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
    return hours ? `${hours}:${tail}` : tail;
  }

  const initialPage = currentPage();
  if (!initialPage || !document.body) return;

  const host = document.createElement('div');
  host.id = hostId;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; --edge: 24px; --resize-target: 30px; position: fixed; z-index: 2147483000;
        --top: calc(var(--edge) + env(safe-area-inset-top, 0px));
        --bottom: calc(var(--edge) + env(safe-area-inset-bottom, 0px));
        inset: var(--top) calc(var(--edge) + env(safe-area-inset-right, 0px))
          var(--bottom) calc(var(--edge) + env(safe-area-inset-left, 0px));
        max-height: calc(100dvh - var(--top) - var(--bottom)); pointer-events: none;
        color: #e7edf4; font: 14px/1.55 system-ui, "Microsoft YaHei", sans-serif; }
      *, *::before, *::after { box-sizing: border-box; }
      [hidden] { display: none !important; }
      button, input, select { font: inherit; color: inherit; }
      button { cursor: pointer; }
      button, input, select { border: 1px solid #42505e; border-radius: 8px; background: #202a35; }
      button { min-height: 36px; padding: 5px 12px; }
      button:hover:not(:disabled) { border-color: #7ad9fd; background: #283848; }
      button:disabled { opacity: .45; cursor: default; }
      :focus-visible { outline: 2px solid #7ad9fd; outline-offset: 2px; }
      #toggle, #panel { position: absolute; pointer-events: auto; }
      #toggle, #resize { touch-action: none; -webkit-user-select: none; user-select: none; }
      #toggle { width: max-content; max-width: 100%; border-color: #71dfff; background: #98e6ff;
        cursor: grab;
        color: #073143; font-weight: 700; padding: 7px 15px; box-shadow: 0 4px 18px #0b17294d; }
      #toggle:hover { background: #c7f1ff; }
      #toggle:active { cursor: grabbing; }
      #panel { display: flex; flex-direction: column;
        border: 1px solid #42505e; border-radius: 14px; background: #151e27;
        color-scheme: dark; box-shadow: 0 12px 38px #0b1729a0; overflow: hidden; }
      #panel[data-above="false"] { padding-bottom: var(--resize-target); }
      .panel-content { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: auto; }
      header, .tools, #status { flex: none; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px 7px; }
      #panel[data-above="true"][data-align-right="true"] header { padding-left: var(--resize-target); }
      #panel[data-above="true"][data-align-right="false"] header { padding-right: var(--resize-target); }
      h2 { font-size: 18px; margin: 0; }
      #close { font-size: 20px; line-height: 1; }
      #resize { position: absolute; right: 0; bottom: 0; width: var(--resize-target); height: var(--resize-target);
        min-height: 0; padding: 0; border: 0; background: transparent; color: #9be6ff;
        cursor: nwse-resize; transform: scale(var(--grip-x, 1), var(--grip-y, 1)); }
      #resize:hover { background: #283848; }
      #resize:focus-visible { outline-offset: -3px; }
      #resize::before, #resize::after { content: ""; position: absolute; right: 8px; bottom: 8px;
        width: 13px; height: 13px; border-right: 2px solid; border-bottom: 2px solid; }
      #resize::after { right: 12px; bottom: 12px; width: 7px; height: 7px; }
      #panel[data-above="true"] #resize { top: 0; bottom: auto; --grip-y: -1; cursor: nesw-resize; }
      #panel[data-align-right="true"] #resize { left: 0; right: auto; --grip-x: -1; cursor: nesw-resize; }
      #panel[data-above="true"][data-align-right="true"] #resize { cursor: nwse-resize; }
      .tools { display: flex; flex-wrap: wrap; gap: 7px; padding: 6px 14px 8px; }
      .font-size { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
      .font-size button { min-width: 36px; padding: 5px 7px; }
      #font-value { min-width: 4ch; text-align: center; font-variant-numeric: tabular-nums; }
      select, input { min-height: 36px; padding: 5px 8px; min-width: 0; }
      select { flex: 1 1 100%; }
      input { flex: 1 1 125px; }
      input::placeholder { color: #a8b7c7; }
      #status { padding: 0 14px 8px; color: #bbccdd; min-height: 30px; overflow-wrap: anywhere; }
      #cues { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; }
      #cues:not(:empty) { min-height: 52px; }
      .cue { display: grid; grid-template-columns: 67px minmax(0, 1fr); align-items: start; gap: 9px;
        padding: 8px 14px; border-top: 1px solid #344351; }
      .cue button { font-variant-numeric: tabular-nums; color: #9be6ff; padding: 0 5px; min-height: 25px; }
      .text { font-size: var(--subtitle-font-size, 14px); white-space: pre-wrap; overflow-wrap: anywhere; }
      @media (any-pointer: coarse) {
        :host { --resize-target: 44px; }
        button, input, select, .cue button { min-height: 44px; }
        .font-size button { min-width: 44px; }
        input, select { font-size: 16px; }
        input { flex-basis: 96px; }
      }
      @media (max-width: 520px), (max-height: 420px) {
        :host { --edge: 12px; }
      }
    </style>
    <button id="toggle" type="button" aria-expanded="false" aria-controls="panel"
      title="点击打开或关闭字幕，拖动或用方向键移动按钮">完整字幕</button>
    <section id="panel" hidden aria-labelledby="heading">
      <div class="panel-content">
        <header><h2 id="heading">完整字幕</h2><button id="close" type="button" aria-label="关闭字幕面板">×</button></header>
        <div class="tools">
          <select id="tracks" aria-label="字幕轨道" disabled></select>
          <input id="search" type="search" placeholder="搜索字幕" aria-label="搜索字幕" disabled>
          <button id="copy" type="button" disabled>复制全文</button>
          <button id="refresh" type="button">重新加载</button>
          <div class="font-size" role="group" aria-label="字幕字号">
            <button id="font-smaller" type="button" aria-label="缩小字幕字号" title="缩小字幕字号">A−</button>
            <output id="font-value"></output>
            <button id="font-larger" type="button" aria-label="放大字幕字号" title="放大字幕字号">A+</button>
          </div>
        </div>
        <div id="status" role="status"></div>
        <div id="cues" aria-label="字幕正文"></div>
      </div>
      <button id="resize" type="button" aria-label="调整字幕面板大小"
        title="拖动或用方向键调整面板大小"></button>
    </section>`;
  document.body.append(host);

  const get = id => shadow.getElementById(id);
  const toggle = get('toggle');
  const panel = get('panel');
  const select = get('tracks');
  const search = get('search');
  const copy = get('copy');
  const status = get('status');
  const list = get('cues');
  const smallerFont = get('font-smaller');
  const largerFont = get('font-larger');

  let page = initialPage;
  let controller;
  let tracks = [];
  let cues = [];
  let requested = false;
  const cache = new Map();

  const layoutKey = `${hostId}:layout`;
  const minPanelWidth = 240;
  const minPanelHeight = 280;
  const panelGap = 8;
  const minFontSize = 12;
  const maxFontSize = 32;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(layoutKey)) ?? {};
  } catch {
    // Storage may be unavailable. The controls still work on this page.
  }
  let position = {
    x: Number.isFinite(saved.position?.x) ? clamp(saved.position.x, 0, 1) : 1,
    y: Number.isFinite(saved.position?.y) ? clamp(saved.position.y, 0, 1) : 1,
  };
  let size = Number.isFinite(saved.size?.width) && Number.isFinite(saved.size?.height) ? {
    width: Math.max(minPanelWidth, saved.size.width),
    height: Math.max(minPanelHeight, saved.size.height),
  } : null;
  let fontSize = Number.isFinite(saved.fontSize) ? clamp(saved.fontSize, minFontSize, maxFontSize) : 14;
  let skipToggleClick = false;

  function saveLayout() {
    try {
      localStorage.setItem(layoutKey, JSON.stringify({ position, size, fontSize }));
    } catch {
      // Keep the current settings in memory.
    }
  }

  function layout() {
    if (!page) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    const buttonWidth = toggle.offsetWidth;
    const buttonHeight = toggle.offsetHeight;
    const maxX = Math.max(0, width - buttonWidth);
    const maxY = Math.max(0, height - buttonHeight);
    const x = Math.round(position.x * maxX);
    const y = Math.round(position.y * maxY);
    toggle.style.left = `${x}px`;
    toggle.style.top = `${y}px`;
    if (panel.hidden) return;

    const above = y >= maxY / 2;
    const alignRight = x >= maxX / 2;
    const room = Math.max(0, (above ? y : maxY - y) - panelGap);
    const panelWidth = Math.min(size?.width ?? 465, width);
    const panelX = clamp(alignRight ? x + buttonWidth - panelWidth : x, 0, width - panelWidth);
    panel.dataset.above = String(above);
    panel.dataset.alignRight = String(alignRight);
    panel.style.width = `${panelWidth}px`;
    panel.style.height = size ? `${Math.min(size.height, room)}px` : 'auto';
    panel.style.maxHeight = `${size ? room : Math.min(room, 660)}px`;
    panel.style.left = `${panelX}px`;
    panel.style.top = above ? 'auto' : `${y + buttonHeight + panelGap}px`;
    panel.style.bottom = above ? `${height - y + panelGap}px` : 'auto';
  }

  function renderFontSize() {
    list.style.setProperty('--subtitle-font-size', `${fontSize}px`);
    get('font-value').textContent = `${fontSize} px`;
    smallerFont.disabled = fontSize <= minFontSize;
    largerFont.disabled = fontSize >= maxFontSize;
  }

  function changeFontSize(amount) {
    fontSize = clamp(fontSize + amount, minFontSize, maxFontSize);
    renderFontSize();
    saveLayout();
  }

  function bindAdjuster(handle, begin) {
    let drag;
    handle.addEventListener('pointerdown', event => {
      if (drag || !event.isPrimary || event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, move: begin() };
      if (event.pointerType !== 'touch') handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      drag.move(dx, dy);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      handle.addEventListener(type, event => {
        if (drag?.id !== event.pointerId) return;
        if (drag.moved) saveLayout();
        drag = null;
      });
    }
    const arrows = new Map([
      ['ArrowLeft', [-16, 0]], ['ArrowRight', [16, 0]],
      ['ArrowUp', [0, -16]], ['ArrowDown', [0, 16]],
    ]);
    handle.addEventListener('keydown', event => {
      const delta = arrows.get(event.key);
      if (!delta || drag) return;
      event.preventDefault();
      event.stopPropagation();
      begin()(...delta);
      saveLayout();
    });
  }

  bindAdjuster(toggle, () => {
    skipToggleClick = false;
    const x = toggle.offsetLeft;
    const y = toggle.offsetTop;
    return (dx, dy) => {
      skipToggleClick = true;
      const maxX = host.clientWidth - toggle.offsetWidth;
      const maxY = host.clientHeight - toggle.offsetHeight;
      position = {
        x: maxX > 0 ? clamp((x + dx) / maxX, 0, 1) : position.x,
        y: maxY > 0 ? clamp((y + dy) / maxY, 0, 1) : position.y,
      };
      layout();
    };
  });
  bindAdjuster(get('resize'), () => {
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const directionX = panel.dataset.alignRight === 'true' ? -1 : 1;
    const directionY = panel.dataset.above === 'true' ? -1 : 1;
    return (dx, dy) => {
      size = {
        width: Math.max(minPanelWidth, width + directionX * dx),
        height: Math.max(minPanelHeight, height + directionY * dy),
      };
      layout();
    };
  });
  smallerFont.addEventListener('click', () => changeFontSize(-2));
  largerFont.addEventListener('click', () => changeFontSize(2));
  renderFontSize();
  layout();
  const layoutObserver = new ResizeObserver(layout);
  layoutObserver.observe(host);
  layoutObserver.observe(toggle);

  function beginRequest() {
    controller?.abort();
    controller = new AbortController();
    return controller.signal;
  }

  function clearText(message) {
    cues = [];
    list.replaceChildren();
    search.disabled = true;
    copy.disabled = true;
    status.textContent = message;
  }

  function render() {
    const query = search.value.trim().toLocaleLowerCase();
    const visible = query ? cues.filter(cue => cue.text.toLocaleLowerCase().includes(query)) : cues;
    const fragment = document.createDocumentFragment();
    for (const cue of visible) {
      const row = document.createElement('div');
      row.className = 'cue';
      const time = document.createElement(cue.start === null ? 'span' : 'button');
      time.textContent = cue.start === null ? '—' : formatTime(cue.start);
      if (time instanceof HTMLButtonElement) {
        time.type = 'button';
        time.dataset.start = String(cue.start);
        time.setAttribute('aria-label', `跳到 ${time.textContent}`);
      }
      const line = document.createElement('span');
      line.className = 'text';
      line.textContent = cue.text;
      row.append(time, line);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    list.scrollTop = 0;
    status.textContent = `P${page.part} · ${query ? `${visible.length} / ${cues.length}` : cues.length} 条` +
      (query && !visible.length ? ' · 没有匹配的字幕' : '');
  }

  async function loadTrack(index) {
    const track = tracks[index];
    if (!track) return;
    const signal = beginRequest();
    search.value = '';
    clearText('正在读取完整字幕…');
    try {
      const loaded = cache.get(track.key) ?? parseCues(await getJson(track.url, signal, 'omit'));
      if (signal.aborted) return;
      cache.set(track.key, loaded);
      if (!loaded.length) {
        status.textContent = '这条字幕轨没有正文。';
        return;
      }
      cues = loaded;
      search.disabled = false;
      copy.disabled = false;
      render();
    } catch (error) {
      if (!signal.aborted) status.textContent = `字幕正文加载失败（${error.message}）。可切换轨道或重新加载。`;
    }
  }

  async function loadPage() {
    const signal = beginRequest();
    requested = true;
    tracks = [];
    cache.clear();
    select.replaceChildren(new Option('选择字幕轨道'));
    select.disabled = true;
    search.value = '';
    clearText('正在查找字幕轨道…');
    try {
      const result = await findTracks(page, signal);
      if (signal.aborted) return;
      tracks = result.tracks;
      if (!tracks.length) {
        status.textContent = result.message;
        return;
      }
      select.replaceChildren(...tracks.map((track, index) => new Option(track.label, String(index))));
      select.disabled = false;
      await loadTrack(0);
    } catch (error) {
      if (!signal.aborted) status.textContent = `字幕轨加载失败（${error.message}）。请重新加载。`;
    }
  }

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      layout();
      if (!requested) void loadPage();
      get('close').focus();
    } else {
      toggle.focus();
    }
  }

  function syncPage() {
    const next = currentPage();
    if (next?.key === page?.key) return;
    controller?.abort();
    page = next;
    requested = false;
    clearText('');
    host.style.display = page ? '' : 'none';
    layout();
    if (page && !panel.hidden) void loadPage();
  }

  toggle.addEventListener('click', event => {
    if (skipToggleClick && event.detail !== 0) {
      skipToggleClick = false;
      return;
    }
    syncPage();
    if (page) setOpen(panel.hidden);
  });
  get('close').addEventListener('click', () => setOpen(false));
  get('refresh').addEventListener('click', () => { if (page) void loadPage(); });
  select.addEventListener('change', () => { void loadTrack(Number(select.value)); });
  search.addEventListener('input', render);
  panel.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') setOpen(false);
  });
  copy.addEventListener('click', async () => {
    const current = cues;
    try {
      await navigator.clipboard.writeText(current.map(cue => cue.text).join('\n'));
      if (current === cues) status.textContent = `已复制 ${current.length} 条字幕。`;
    } catch {
      if (current === cues) status.textContent = '浏览器未允许访问剪贴板，可选中字幕文字后手动复制。';
    }
  });
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-start]');
    if (!button) return;
    const player = document.querySelector('.bpx-player-video-wrap video, #bilibili-player video, #bilibili-player bwp-video');
    try {
      if (!player || !('currentTime' in player)) throw new Error();
      player.currentTime = Number(button.dataset.start);
    } catch {
      status.textContent = '当前播放器尚不能跳转，请先播放或等待视频加载。';
    }
  });

  // B 站在切换分 P 或合集视频时可能仅更新 URL，不重新加载整个页面。
  window.addEventListener('popstate', syncPage);
  window.setInterval(syncPage, 450);
})();
