// ==UserScript==
// @name         哔哩哔哩完整字幕
// @namespace    local.bilibili.transcript
// @version      1.1.0
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
      :host { all: initial; --edge: 24px; position: fixed; z-index: 2147483000;
        right: calc(var(--edge) + env(safe-area-inset-right, 0px));
        bottom: calc(var(--edge) + env(safe-area-inset-bottom, 0px));
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
      #toggle { display: block; margin-left: auto; border-color: #71dfff; background: #98e6ff;
        color: #073143; font-weight: 700; padding: 7px 15px; box-shadow: 0 4px 18px #0b17294d; }
      #toggle:hover { background: #c7f1ff; }
      #panel { position: absolute; right: 0; bottom: 51px; display: flex; flex-direction: column;
        width: min(465px, calc(100vw - 2 * var(--edge) - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
        max-height: min(660px, calc(100vh - 110px - env(safe-area-inset-bottom, 0px)));
        max-height: min(660px, calc(100dvh - 110px - env(safe-area-inset-bottom, 0px)));
        border: 1px solid #42505e; border-radius: 14px; background: #151e27;
        color-scheme: dark; box-shadow: 0 12px 38px #0b1729a0; overflow: hidden; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px 7px; }
      h2 { font-size: 18px; margin: 0; }
      #close { font-size: 20px; line-height: 1; }
      .tools { display: flex; flex-wrap: wrap; gap: 7px; padding: 6px 14px 8px; }
      select, input { min-height: 36px; padding: 5px 8px; min-width: 0; }
      select { flex: 1 1 100%; }
      input { flex: 1 1 125px; }
      input::placeholder { color: #a8b7c7; }
      #status { padding: 0 14px 8px; color: #bbccdd; min-height: 30px; overflow-wrap: anywhere; }
      #cues { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; }
      .cue { display: grid; grid-template-columns: 67px minmax(0, 1fr); align-items: start; gap: 9px;
        padding: 8px 14px; border-top: 1px solid #344351; }
      .cue button { font-variant-numeric: tabular-nums; color: #9be6ff; padding: 0 5px; min-height: 25px; }
      .text { white-space: pre-wrap; overflow-wrap: anywhere; }
      @media (any-pointer: coarse) {
        button, input, select, .cue button { min-height: 44px; }
        input, select { font-size: 16px; }
      }
      @media (max-width: 520px) {
        :host { --edge: 12px; }
      }
    </style>
    <button id="toggle" type="button" aria-expanded="false" aria-controls="panel">完整字幕</button>
    <section id="panel" hidden aria-labelledby="heading">
      <header><h2 id="heading">完整字幕</h2><button id="close" type="button" aria-label="关闭字幕面板">×</button></header>
      <div class="tools">
        <select id="tracks" aria-label="字幕轨道" disabled></select>
        <input id="search" type="search" placeholder="搜索字幕" aria-label="搜索字幕" disabled>
        <button id="copy" type="button" disabled>复制全文</button>
        <button id="refresh" type="button">重新加载</button>
      </div>
      <div id="status" role="status"></div>
      <div id="cues" aria-label="字幕正文"></div>
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

  let page = initialPage;
  let controller;
  let tracks = [];
  let cues = [];
  let requested = false;
  const cache = new Map();

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
    if (page && !panel.hidden) void loadPage();
  }

  toggle.addEventListener('click', () => {
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
