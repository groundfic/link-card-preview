'use strict';

const { Plugin, MarkdownView, Notice, requestUrl, editorLivePreviewField, Platform, PluginSettingTab, Setting } = require('obsidian');

/* CodeMirror 6（Live Preview 用）。防禦性載入：失敗時編輯模式不渲染卡片，
   但 Reading Mode 與 Canvas 完全不受影響 */
let cm = null;
try {
  cm = {
    view: require('@codemirror/view'),
    state: require('@codemirror/state'),
  };
} catch (e) {
  console.log('[LCP] CodeMirror modules unavailable, Live Preview cards disabled');
}

/* ============ 常數 ============ */

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const META_TTL = 7 * 24 * 60 * 60 * 1000;
const FAIL_TTL = 15 * 60 * 1000; // 抓取失敗的結果只快取 15 分鐘，換裝置開啟時可自動重試
const MAX_CACHE_ENTRIES = 500; // 快取項目上限，超過時淘汰最舊的（含 base64 圖，避免記憶體與 data.json 無限膨脹）
const MAX_IMAGE_BYTES = 300 * 1024;
const DOWNSCALE_WIDTH = 640;

const DEFAULT_SETTINGS = {
  threadsPasteInsert: true, // 貼上 Threads 連結時自動插入貼文文字
  youtubeCanvasEmbed: false, // Canvas 中 YouTube 連結：false=卡片預覽，true=保留原生嵌入
};

/* Apple 風格設定 */
const SHOW_DESCRIPTION = false;   // Apple 卡片不顯示描述；想要回來改 true 即可
const LARGE_MIN_WIDTH = 320;      // 圖片寬度達此值且非直向 → 大卡版型

const EXTLINK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

const PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';

const GLOBE_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm-.354 14.933A7 7 0 0 1 1.02 8.73h2.49c.08 1.7.46 3.2 1.02 4.34a6.97 6.97 0 0 1-2.884 1.863zM1.02 7.27A7 7 0 0 1 7.646 1.07v2.07c-1.52.18-2.82 2.1-3.14 4.13H1.02zm6.626 7.663V12.5c1.18-.13 2.22-1.54 2.62-3.5H7.646zm0-3.933V7.27h2.62c-.4-1.96-1.44-3.37-2.62-3.5V5.5zm1.354-6.933A7 7 0 0 1 14.98 7.27h-2.49c-.08-1.7-.46-3.2-1.02-4.34a6.97 6.97 0 0 1 2.884-1.863zM8.354 1.07A7 7 0 0 1 14.98 8.73h-2.49c-.32-2.03-1.62-3.95-4.136-4.13V1.07zm-2.626 12.93v2.433a6.97 6.97 0 0 1-2.884-1.863c.56-1.14.94-2.64 1.02-4.34h2.49c-.4 1.96-1.44 3.37-2.62 3.5z"/></svg>';

/* ============ 共享狀態 ============ */

const state = {
  cache: {},
  save: () => {},
};

/* ============ 工具函式 ============ */

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function isThreadsUrl(url) {
  const h = hostOf(url);
  return h === 'threads.net' || h === 'threads.com';
}

function isInstagramUrl(url) {
  const h = hostOf(url);
  return h === 'instagram.com' || h === 'instagr.am';
}

function isYouTubeUrl(url) {
  const h = hostOf(url);
  return h === 'youtube.com' || h === 'youtu.be' || h === 'm.youtube.com'
    || h === 'music.youtube.com';
}

// Meta 系平台共用同一套 oEmbed + 降級抓取邏輯
function isMetaUrl(url) {
  return isThreadsUrl(url) || isInstagramUrl(url);
}

/** 去除手機 App 分享連結附帶的追蹤參數（?igsh=、?xmt= 等）。
 *  Meta 的 oEmbed 對帶陌生參數的網址經常直接拒絕，
 *  這是「手機貼上失效、電腦貼上正常」的主因 */
function canonicalMetaUrl(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

function needsImageProxy(imageUrl) {
  return /cdninstagram|fbcdn|twimg|pbs\.twimg/i.test(imageUrl);
}

function faviconUrl(hostname) {
  return 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(hostname) + '&sz=64';
}

function isSoloParagraph(p) {
  const children = Array.from(p.childNodes);
  if (children.length !== 1) return false;
  const child = children[0];
  if (child.nodeType !== 1 || child.tagName !== 'A') return false;
  const href = child.getAttribute('href') ?? '';
  const text = child.textContent?.trim() ?? '';
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch {}
  return (text === href || text === decoded) &&
    (href.startsWith('http://') || href.startsWith('https://'));
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  try {
    const doc = new DOMParser().parseFromString(str, 'text/html');
    return doc.documentElement.textContent || str;
  } catch (e) {
    return str
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  }
}

function extractTextFromHtml(htmlStr) {
  if (!htmlStr) return '';
  const stripped = htmlStr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return decodeHtmlEntities(stripped);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ============ Metadata 解析 ============ */

function parseMetadata(html, url) {
  const hostname = hostOf(url);
  let doc = null;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch {}

  const pick = (...selectors) => {
    if (!doc) return '';
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      const v = el?.getAttribute('content');
      if (v && v.trim()) return v.trim();
    }
    return '';
  };

  let title = pick('meta[property="og:title"]', 'meta[name="twitter:title"]');
  if (!title && doc) {
    title = doc.querySelector('title')?.textContent?.trim() || '';
  }

  const description = pick(
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]'
  );

  let image = pick(
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[name="twitter:image"]'
  );

  // 退路 1：<link rel="image_src">（舊式但仍有網站在用）
  if (!image && doc) {
    image = doc.querySelector('link[rel="image_src"]')?.getAttribute('href') || '';
  }

  // 退路 2：掃描內容圖片。許多網站用 lazy loading，<img src> 是佔位圖，
  // 真實網址藏在 data-src / data-lazy-src / srcset 等屬性裡
  if (!image && doc) {
    const imgs = Array.from(doc.querySelectorAll('img')).slice(0, 30);
    for (const im of imgs) {
      const candidates = [
        im.getAttribute('data-src'),
        im.getAttribute('data-lazy-src'),
        im.getAttribute('data-original'),
        (im.getAttribute('data-srcset') || im.getAttribute('srcset') || '').trim().split(/[\s,]+/)[0],
        im.getAttribute('src'),
      ];
      const cand = candidates.find((c) => c && !c.startsWith('data:'));
      if (!cand) continue;
      // 跳過佔位圖與追蹤像素
      if (/blank|spacer|placeholder|loading|pixel|1x1|\.svg(\?|$)/i.test(cand)) continue;
      image = cand;
      break;
    }
  }

  // 退路 3：apple-touch-icon（高解析網站 icon，Apple 沒圖時的行為）
  if (!image && doc) {
    image = doc.querySelector('link[rel~="apple-touch-icon"]')?.getAttribute('href') || '';
  }

  if (image) {
    try { image = new URL(image, url).href; } catch { image = ''; }
  }

  return { title: title || hostname, description, image, hostname };
}

/* ============ 抓取：一般網站（UA 重試） ============ */

async function fetchGenericMeta(url) {
  const hostname = hostOf(url);
  let best = null;

  for (const ua of [DESKTOP_UA, BOT_UA]) {
    try {
      const res = await requestUrl({
        url,
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-TW,zh;q=0.9,ja;q=0.8,en;q=0.7',
        },
        throw: false,
      });
      if (!res || res.status >= 400 || !res.text) continue;

      const meta = parseMetadata(res.text, url);
      if (!best) {
        best = meta;
      } else {
        best = {
          title: best.title !== hostname ? best.title : meta.title,
          description: best.description || meta.description,
          image: best.image || meta.image,
          hostname,
        };
      }
      if (best.title !== hostname && best.image) break;
    } catch (e) {
      console.log('[LCP] fetch failed:', e.message);
    }
  }

  return best || { title: hostname, description: '', image: '', hostname };
}

/* ============ 抓取：Threads 特化 ============ */

async function fetchMetaPlatform(url) {
  const ig = isInstagramUrl(url);
  // showDesc：貼文內文本身就是內容本體，不受全域 SHOW_DESCRIPTION 限制
  const base = {
    title: ig ? 'Instagram' : 'Threads',
    description: '', image: '', hostname: hostOf(url), showDesc: true,
  };

  try {
    // Threads 與 Instagram 的 oEmbed 都由 Meta 後端提供
    const oembedUrl = ig
      ? 'https://www.instagram.com/api/v1/oembed/?url=' + encodeURIComponent(url)
      : 'https://www.threads.net/oembed/?url=' + encodeURIComponent(url);
    const res = await requestUrl({ url: oembedUrl, headers: { 'Accept': 'application/json' }, throw: false });
    if (res && res.status === 200) {
      const data = JSON.parse(res.text);
      if (data.author_name) base.title = '@' + data.author_name;
      if (data.html) base.description = extractTextFromHtml(data.html);
      if (data.title) base.description = base.description || data.title;
      if (data.thumbnail_url) base.image = data.thumbnail_url;
    }
  } catch (e) {
    console.log('[LCP] oEmbed failed:', e.message);
  }

  if (base.image) return base;

  for (const ua of [BOT_UA, DESKTOP_UA]) {
    try {
      const res = await requestUrl({
        url,
        headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml' },
        throw: false,
      });
      if (!res || res.status >= 400 || !res.text) continue;
      const html = res.text;

      const meta = parseMetadata(html, url);
      if (meta.image) base.image = meta.image;
      if (!base.description && meta.description) base.description = meta.description;
      if ((!base.title || base.title === 'Threads' || base.title === 'Instagram') && meta.title !== base.hostname) base.title = meta.title;

      if (base.image) return base;

      const ldMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      if (ldMatch) {
        try {
          const json = JSON.parse(ldMatch[1]);
          const img = json.image || json.thumbnailUrl;
          if (img) {
            base.image = typeof img === 'string' ? img : (img.url || '');
            if (base.image) return base;
          }
        } catch (e) {}
      }

      const cdnMatch = html.match(/https:\/\/[^"'\s\\]+(?:cdninstagram|fbcdn)[^"'\s\\]+\.jpg[^"'\s\\]*/);
      if (cdnMatch) {
        base.image = decodeHtmlEntities(cdnMatch[0]).replace(/\\u0026/g, '&');
        return base;
      }
    } catch (e) {
      console.log('[LCP] Threads HTML fetch failed:', e.message);
    }
  }

  return base;
}

/* ============ 抓取入口（持久化快取） ============ */

/** 快取超過上限時，依時間戳淘汰最舊的項目（粗略 LRU）。
 *  base64 圖佔記憶體大宗，這道閘門避免長期使用後膨脹 */
function pruneCache() {
  const keys = Object.keys(state.cache);
  if (keys.length <= MAX_CACHE_ENTRIES) return;
  keys
    .sort((a, b) => (state.cache[a].ts || 0) - (state.cache[b].ts || 0))
    .slice(0, keys.length - MAX_CACHE_ENTRIES)
    .forEach((k) => delete state.cache[k]);
}

async function fetchMeta(url) {
  // Meta 系網址先正規化，讓「手機帶 igsh」與「電腦乾淨網址」共用同一筆快取
  if (isMetaUrl(url)) url = canonicalMetaUrl(url);
  const entry = state.cache[url];
  if (entry && entry.meta) {
    const ttl = entry.meta.poor ? FAIL_TTL : META_TTL;
    if (Date.now() - (entry.ts || 0) < ttl || entry.meta.imageData) {
      return entry.meta;
    }
  }

  let meta;
  try {
    meta = isMetaUrl(url) ? await fetchMetaPlatform(url) : await fetchGenericMeta(url);
  } catch (e) {
    const hostname = hostOf(url);
    meta = { title: hostname, description: '', image: '', hostname };
  }

  if (entry?.meta?.imageData && !meta.imageData) {
    meta.imageData = entry.meta.imageData;
    meta.layout = entry.meta.layout;
  }

  // 品質判定：沒抓到圖也沒抓到實質標題／描述 → 視為失敗，走短 TTL
  const hostname = meta.hostname;
  meta.poor = !meta.image && !meta.imageData && !meta.description &&
    (meta.title === hostname || meta.title === 'Threads' || meta.title === 'Instagram');

  state.cache[url] = { meta, ts: Date.now() };
  pruneCache();
  state.save();
  return meta;
}

/* ============ 圖片處理 ============ */

async function downscaleDataUri(dataUri, maxWidth, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        if (scale >= 1) { resolve(dataUri); return; }
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (e) { resolve(dataUri); }
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

async function fetchImageAsDataUri(imageUrl, pageUrl) {
  try {
    let referer = '';
    try { referer = new URL(pageUrl).origin + '/'; } catch {}

    const res = await requestUrl({
      url: imageUrl,
      headers: {
        'User-Agent': DESKTOP_UA,
        ...(referer ? { 'Referer': referer } : {}),
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      throw: false,
    });
    if (!res || res.status !== 200 || !res.arrayBuffer) return '';

    const ct = (res.headers?.['content-type'] || res.headers?.['Content-Type'] || 'image/jpeg').split(';')[0];
    if (!ct.startsWith('image/')) return '';

    let dataUri = 'data:' + ct + ';base64,' + arrayBufferToBase64(res.arrayBuffer);
    if (res.arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      dataUri = await downscaleDataUri(dataUri, DOWNSCALE_WIDTH, 0.8);
    }
    return dataUri;
  } catch (e) {
    console.log('[LCP] image fetch failed:', e.message);
    return '';
  }
}

function persistImage(pageUrl, dataUri) {
  const entry = state.cache[pageUrl];
  if (entry?.meta) {
    entry.meta.imageData = dataUri;
    state.save();
  }
}

/** 載入圖片並回傳實際尺寸；失敗回 null（兼作直連可用性探測） */
function loadImageDims(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Apple 式主色提取：縮到 24×24 取樣，量化分箱統計，
 *  忽略近白／近黑，並用飽和度加權讓主題色贏過大片灰底。
 *  回傳 [r, g, b] 或 null（圖片載入失敗、CORS 污染等）。 */
function extractDominantColor(src) {
  return new Promise((resolve) => {
    const img = new Image();
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const S = 24;
        const canvas = document.createElement('canvas');
        canvas.width = S;
        canvas.height = S;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, S, S);
        const data = ctx.getImageData(0, 0, S, S).data; // 跨域未授權時這行會丟錯

        const bins = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 125) continue;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const light = (max + min) / 2;
          if (light > 242 || light < 14) continue; // 近白近黑不具代表性
          const key = ((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5);
          const bin = bins.get(key) || { r: 0, g: 0, b: 0, n: 0, sat: 0 };
          bin.r += r; bin.g += g; bin.b += b; bin.n++;
          bin.sat += (max - min);
          bins.set(key, bin);
        }
        if (!bins.size) { resolve(null); return; }

        let best = null, bestScore = -1;
        bins.forEach((bin) => {
          const score = bin.n * (1 + (bin.sat / bin.n) / 128);
          if (score > bestScore) { bestScore = score; best = bin; }
        });
        resolve([
          Math.round(best.r / best.n),
          Math.round(best.g / best.n),
          Math.round(best.b / best.n),
        ]);
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** 依相對亮度判斷主色是深是淺，決定文字用白或黑 */
function isDarkTint(tint) {
  const [r, g, b] = tint;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 150;
}

/** 取得可顯示的圖片來源：本地快取 → 防盜連 CDN 直接下載 → 直連探測 → 失敗下載補救
 *  尺寸量測結果存進快取（meta.dims），Canvas 重掛載卡片時不必重新解碼圖片 */
async function resolveImage(pageUrl, meta) {
  if (meta.imageData) {
    if (!meta.dims) {
      meta.dims = await loadImageDims(meta.imageData);
      state.save();
    }
    return { src: meta.imageData, dims: meta.dims };
  }
  if (!meta.image) return { src: '', dims: null };

  if (needsImageProxy(meta.image) || isMetaUrl(pageUrl)) {
    const d = await fetchImageAsDataUri(meta.image, pageUrl);
    if (d) {
      meta.imageData = d;
      meta.dims = await loadImageDims(d);
      persistImage(pageUrl, d);
      return { src: d, dims: meta.dims };
    }
    return { src: '', dims: null };
  }

  if (meta.dims) return { src: meta.image, dims: meta.dims };

  const dims = await loadImageDims(meta.image);
  if (dims) {
    meta.dims = dims;
    state.save();
    return { src: meta.image, dims };
  }

  const d = await fetchImageAsDataUri(meta.image, pageUrl);
  if (d) {
    meta.imageData = d;
    meta.dims = await loadImageDims(d);
    persistImage(pageUrl, d);
    return { src: d, dims: meta.dims };
  }
  return { src: '', dims: null };
}

/** 開啟按鈕：Live Preview 與行動端 Canvas 共用。
 *  桌面 hover 浮現；行動端常駐顯示並加大觸控目標（CSS 以 .is-mobile 切換） */
function buildOpenButton(url) {
  const btn = document.createElement('div');
  btn.className = 'lcp-open-btn';
  btn.setAttribute('aria-label', 'Open link');
  btn.innerHTML = EXTLINK_SVG;
  const open = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(url, '_blank');
  };
  btn.addEventListener('mousedown', open);
  btn.addEventListener('touchend', open);
  return btn;
}

/* ============ 卡片渲染（Apple 三版型） ============ */

function createSkeleton(url) {
  const wrap = document.createElement('div');
  wrap.className = 'lcp-card lcp-card--compact lcp-skeleton';

  const body = document.createElement('div');
  body.className = 'lcp-body';

  const l1 = document.createElement('div');
  l1.className = 'lcp-skeleton-line lcp-skeleton-line--title';

  const host = document.createElement('div');
  host.className = 'lcp-domain';
  host.textContent = hostOf(url);

  body.append(l1, host);

  const thumb = document.createElement('div');
  thumb.className = 'lcp-thumb lcp-thumb--skeleton';

  wrap.append(body, thumb);
  return wrap;
}

/** 網域列：favicon ＋ 裸網域（favicon 載不到時退回地球 icon） */
function buildDomainRow(hostname) {
  const row = document.createElement('div');
  row.className = 'lcp-domain';

  const fav = document.createElement('img');
  fav.className = 'lcp-favicon';
  fav.src = faviconUrl(hostname);
  fav.onerror = () => {
    const span = document.createElement('span');
    span.className = 'lcp-favicon lcp-favicon--fallback';
    span.innerHTML = GLOBE_SVG;
    fav.replaceWith(span);
  };
  row.appendChild(fav);

  row.appendChild(document.createTextNode(hostname));
  return row;
}

function buildTitle(meta) {
  const el = document.createElement('div');
  el.className = 'lcp-title';
  el.textContent = meta.title || meta.hostname;
  return el;
}

function buildDesc(meta) {
  if ((!SHOW_DESCRIPTION && !meta.showDesc) || !meta.description) return null;
  const el = document.createElement('div');
  el.className = 'lcp-desc';
  el.textContent = meta.description;
  return el;
}

async function renderCard(wrap, url, meta, opts = {}) {
  const { src, dims } = await resolveImage(url, meta);

  /* 主色：版型決策前先取得（icon 卡要用它鋪整片底色），每個網址只算一次 */
  let tint = null;
  if (src) {
    tint = meta.tint;
    if (tint === undefined) {
      tint = await extractDominantColor(src);
      meta.tint = tint || null;
      state.save();
    }
  }

  /* icon 類圖片：尺寸偏小（apple-touch-icon、favicon、小縮圖） */
  const iconLike = !!(dims && Math.max(dims.w, dims.h) <= 256);
  /* 直向圖：大卡 hero 改裁 1:1 方形，避免 1.91:1 砍掉太多、也避免卡片過長 */
  const portrait = !!(dims && dims.h > dims.w * 1.1);

  /* 版型決策（Apple 邏輯）：
     大圖（寬 >= 320）→ 大卡（直向圖裁方形）
     小圖 → 緊湊卡（縮圖在右）
     無圖 → 純文字卡
     Canvas ＋ icon 類圖 → icon 卡（主色鋪滿、icon 置中） */
  let layout;
  if (opts.canvas) {
    layout = src ? (iconLike ? 'canvas-icon' : 'canvas') : 'canvas-text';
  } else if (!src) {
    layout = 'text';
  } else if (dims && dims.w >= LARGE_MIN_WIDTH && !iconLike) {
    layout = 'large';
  } else {
    layout = 'compact';
  }

  wrap.textContent = '';
  wrap.setAttribute('role', 'link');
  wrap.setAttribute('tabindex', '0');

  const body = document.createElement('div');
  body.className = 'lcp-body';

  if (layout === 'large') {
    wrap.className = 'lcp-card lcp-card--large';
    const hero = document.createElement('div');
    hero.className = 'lcp-hero' + (portrait ? ' lcp-hero--portrait' : '');
    hero.style.backgroundImage = 'url("' + src + '")';
    body.appendChild(buildTitle(meta));
    const d = buildDesc(meta);
    if (d) body.appendChild(d);
    body.appendChild(buildDomainRow(meta.hostname));
    wrap.append(hero, body);

  } else if (layout === 'compact') {
    wrap.className = 'lcp-card lcp-card--compact';
    body.appendChild(buildTitle(meta));
    const d = buildDesc(meta);
    if (d) body.appendChild(d);
    body.appendChild(buildDomainRow(meta.hostname));
    const thumb = document.createElement('div');
    thumb.className = 'lcp-thumb' + (iconLike ? ' lcp-thumb--icon' : '');
    thumb.style.backgroundImage = 'url("' + src + '")';
    wrap.append(body, thumb);

  } else if (layout === 'canvas-icon') {
    wrap.className = 'lcp-card lcp-card--canvas lcp-card--canvas-icon';
    const stage = document.createElement('div');
    stage.className = 'lcp-icon-stage';
    const iconImg = document.createElement('img');
    iconImg.className = 'lcp-icon-img';
    iconImg.src = src;
    stage.appendChild(iconImg);
    body.appendChild(buildTitle(meta));
    body.appendChild(buildDomainRow(meta.hostname));
    wrap.append(stage, body);
    if (tint) {
      wrap.classList.add('lcp-card--solid');
      wrap.classList.add(isDarkTint(tint) ? 'lcp-on-dark' : 'lcp-on-light');
    }

  } else if (layout === 'text') {
    wrap.className = 'lcp-card lcp-card--text';
    body.appendChild(buildTitle(meta));
    body.appendChild(buildDomainRow(meta.hostname));
    wrap.append(body);

  } else if (layout === 'canvas') {
    wrap.className = 'lcp-card lcp-card--canvas';
    const hero = document.createElement('div');
    hero.className = 'lcp-hero';
    hero.style.backgroundImage = 'url("' + src + '")';
    body.appendChild(buildTitle(meta));
    const d = buildDesc(meta);
    if (d) body.appendChild(d);
    body.appendChild(buildDomainRow(meta.hostname));
    wrap.append(hero, body);

  } else { // canvas-text
    wrap.className = 'lcp-card lcp-card--canvas lcp-card--canvas-text';
    body.appendChild(buildTitle(meta));
    const d = buildDesc(meta) || (meta.description ? (() => {
      const el = document.createElement('div');
      el.className = 'lcp-desc';
      el.textContent = meta.description;
      return el;
    })() : null);
    if (d) body.appendChild(d); // 無圖的 canvas 卡片空間大，描述放回來填充
    body.appendChild(buildDomainRow(meta.hostname));
    wrap.append(body);
  }

  /* 染色套用：icon 卡（solid）鋪滿主色，其餘卡片 12% 淡染 */
  if (tint) {
    wrap.style.setProperty('--lcp-tint', tint.join(', '));
    if (!wrap.classList.contains('lcp-card--solid')) {
      wrap.classList.add('lcp-card--tinted');
    }
  }

  const handler = () => window.open(url, '_blank');
  if (opts.canvas) {
    wrap.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handler();
    });
    // 行動端：觸控雙點不可靠，補一顆常駐開啟按鈕
    if (Platform.isMobile) {
      wrap.appendChild(buildOpenButton(url));
    }
  } else if (!opts.editor) {
    // Live Preview（editor）的互動由 widget 容器統一管理：單擊選取、⌘+單擊開啟
    wrap.addEventListener('click', handler);
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter') handler(); });
  }
}

/* ============ Live Preview（編輯模式）擴充 ============ */

/* 拖曳選取期間的穩定機制：
   選取進行中只移除被蓋到的卡片、不把離開選取的行變回卡片，
   避免卡片高度差造成版面跳動、選取亂飄；放開後才重新結算 */
let lcpDragging = false;
let RefreshAnno = null;

function buildLivePreviewExtension() {
  if (!cm) return null;
  const { EditorView, Decoration, WidgetType } = cm.view;
  const { StateField } = cm.state;

  const URL_LINE = /^(https?:\/\/\S+)$/;

  class CardWidget extends WidgetType {
    constructor(url) {
      super();
      this.url = url;
    }
    eq(other) {
      return other.url === this.url;
    }
    toDOM(view) {
      const container = document.createElement('div');
      container.className = 'lcp-lp-container';

      const inner = document.createElement('div');
      inner.className = 'lcp-lp-inner';
      container.appendChild(inner);

      const skeleton = createSkeleton(this.url);
      inner.appendChild(skeleton);
      fetchMeta(this.url).then((meta) =>
        renderCard(skeleton, this.url, meta, { editor: true })
      );

      // 編輯按鈕（鉛筆）：還原並反白裸網址供編輯
      // 桌面 hover 浮現；行動端常駐（觸控沒有 hover 也沒有 ⌘）
      const selectLine = () => {
        try {
          const pos = view.posAtDOM(container);
          const line = view.state.doc.lineAt(pos);
          view.dispatch({ selection: { anchor: line.from, head: line.to } });
          view.focus();
        } catch (err) {}
      };
      const editBtn = document.createElement('div');
      editBtn.className = 'lcp-open-btn';
      editBtn.setAttribute('aria-label', 'Edit URL');
      editBtn.innerHTML = PENCIL_SVG;
      const onEdit = (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectLine();
      };
      editBtn.addEventListener('mousedown', onEdit);
      editBtn.addEventListener('touchend', onEdit);
      inner.appendChild(editBtn);

      // 單擊＝開啟連結（卡片的主動作）
      // ⌘/Ctrl＋單擊＝選取編輯（次要動作的鍵盤捷徑）
      container.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.lcp-open-btn')) return;
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) {
          selectLine();
          return;
        }
        window.open(this.url, '_blank');
      });

      return container;
    }
    ignoreEvent() {
      return true; // 事件交給容器自己的 handler
    }
  }

  function buildDecos(state) {
    // 純 Source Mode 不渲染，維持原始文字
    if (editorLivePreviewField) {
      const lp = state.field(editorLivePreviewField, false);
      if (lp === false) return Decoration.none;
    }

    const widgets = [];
    const doc = state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const m = line.text.trim().match(URL_LINE);
      if (!m) continue;

      // 游標或選取範圍碰到這一行 → 還原裸網址供編輯
      let onLine = false;
      for (const r of state.selection.ranges) {
        if (r.from <= line.to && r.to >= line.from) { onLine = true; break; }
      }
      if (onLine) continue;

      widgets.push(
        Decoration.replace({
          widget: new CardWidget(m[1]),
          block: true,
        }).range(line.from, line.to)
      );
    }
    return Decoration.set(widgets);
  }

  /* 移除與目前選取重疊的卡片（不新增任何卡片） */
  function stripSelected(decos, state) {
    return decos.update({
      filter: (from, to) => {
        for (const r of state.selection.ranges) {
          if (r.from <= to && r.to >= from) return false;
        }
        return true;
      },
    });
  }

  RefreshAnno = cm.state.Annotation.define();

  // 區塊型 widget 必須由 StateField 提供（CM6 限制，ViewPlugin 不行）
  const field = StateField.define({
    create: buildDecos,
    update(value, tr) {
      if (tr.annotation(RefreshAnno) || tr.docChanged) {
        return buildDecos(tr.state);
      }
      if (tr.selection) {
        // 拖曳中：只還原被選到的，不變回卡片 → 版面穩定
        if (lcpDragging) return stripSelected(value.map(tr.changes), tr.state);
        return buildDecos(tr.state);
      }
      return value.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // 在編輯器內按下滑鼠／觸控即進入「拖曳中」狀態（放開由 plugin 的全域監聽處理）
  const dragWatch = EditorView.domEventHandlers({
    mousedown: () => { lcpDragging = true; return false; },
    touchstart: () => { lcpDragging = true; return false; },
  });

  return [field, dragWatch];
}

/* ============ Plugin 主體 ============ */

class LinkCardPlugin extends Plugin {
  async onload() {
    const data = await this.loadData();
    state.cache = data?.cache || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
    let saveTimer = null;
    state.save = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        this.saveData({ cache: state.cache, settings: this.settings }).catch(() => {});
      }, 1500);
    };

    this.addSettingTab(new LinkCardSettingTab(this.app, this));

    this.addCommand({
      id: 'lcp-clear-cache',
      name: 'Clear link card cache',
      callback: async () => {
        state.cache = {};
        await this.saveData({ cache: {}, settings: this.settings });
        new Notice('Link Card Preview: cache cleared.');
      },
    });

    // 預覽模式：渲染卡片
    this.registerMarkdownPostProcessor((el) => {
      const paragraphs = el.querySelectorAll('p');
      paragraphs.forEach((p) => {
        if (!isSoloParagraph(p)) return;
        const url = p.querySelector('a').getAttribute('href');
        const skeleton = createSkeleton(url);
        p.replaceWith(skeleton);
        fetchMeta(url).then((meta) => renderCard(skeleton, url, meta));
      });
    });

    // 編輯模式（Live Preview）：渲染卡片，單擊開啟、鉛筆按鈕選取編輯
    const lpExtension = buildLivePreviewExtension();
    if (lpExtension) {
      this.registerEditorExtension(lpExtension);

      // 放開滑鼠／手指才結束「拖曳中」狀態並重新結算卡片
      // （掛在 document 上：拖到編輯器外放開也要能收尾）
      const endDrag = () => {
        if (!lcpDragging) return;
        lcpDragging = false;
        if (!RefreshAnno) return;
        this.app.workspace.iterateAllLeaves((leaf) => {
          const v = leaf.view;
          if (v instanceof MarkdownView && v.editor?.cm) {
            try {
              v.editor.cm.dispatch({ annotations: RefreshAnno.of(true) });
            } catch (e) {}
          }
        });
      };
      this.registerDomEvent(document, 'mouseup', endDrag);
      this.registerDomEvent(document, 'touchend', endDrag);
    }

    // Canvas：把 link node 的內嵌網頁換成 lcp 卡片
    this.setupCanvasPatch();

    // 編輯模式：貼上 Threads 連結時自動插入描述
    this.registerDomEvent(document, 'paste', async (evt) => {
      if (!this.settings.threadsPasteInsert) return;
      const text = evt.clipboardData?.getData('text/plain')?.trim();
      if (!text || !isMetaUrl(text)) return;

      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!activeView) return;

      const editor = activeView.editor;
      setTimeout(async () => {
        try {
          const meta = await fetchMeta(text);
          if (!meta.description) return;
          const cursor = editor.getCursor();
          const insertPos = { line: cursor.line, ch: editor.getLine(cursor.line).length };
          editor.replaceRange('\n' + meta.description, insertPos);
        } catch (e) {
          console.log('[LCP] paste insert failed:', e.message);
        }
      }, 100);
    });
  }

  setupCanvasPatch() {
    // view → cleanup 函式，用來回收已關閉 Canvas 的 observer
    this._canvasObservers = new Map();

    const syncCanvasObservers = () => {
      // 1. 對目前開著的 Canvas 掛上 observer（已掛的會被 __lcpAttached 擋掉）
      const liveViews = new Set();
      this.app.workspace.getLeavesOfType('canvas').forEach((leaf) => {
        if (leaf.view) {
          liveViews.add(leaf.view);
          this.attachToCanvas(leaf.view);
        }
      });
      // 2. 回收已不存在於工作區的 Canvas observer（防殭屍累積）
      for (const [view, cleanup] of this._canvasObservers) {
        if (!liveViews.has(view)) cleanup();
      }
    };

    this.registerEvent(this.app.workspace.on('layout-change', syncCanvasObservers));
    this.registerEvent(this.app.workspace.on('active-leaf-change', syncCanvasObservers));
    syncCanvasObservers();
  }

  attachToCanvas(view) {
    if (!view || !view.canvas || view.__lcpAttached) return;
    view.__lcpAttached = true;

    const root = view.canvas.canvasEl || view.containerEl;
    if (!root) return;

    const processAll = () => {
      try {
        view.canvas.nodes?.forEach((node) => this.processCanvasNode(node));
      } catch (e) {}
    };

    /* 單一 observer ＋ debounce：
       Canvas 平移縮放時會大量增刪節點內容（視野外節點虛擬化），
       不 debounce 的話每次變動都觸發全量掃描，卡片一多就拖垮效能 */
    let pending = null;
    const scheduleProcess = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        processAll();
      }, 120);
    };

    const obs = new MutationObserver(scheduleProcess);
    obs.observe(root, { childList: true, subtree: true });

    const cleanup = () => {
      obs.disconnect();
      if (pending) { clearTimeout(pending); pending = null; }
      view.__lcpAttached = false;
      this._canvasObservers.delete(view);
    };
    // 集中追蹤所有作用中的 Canvas observer，供 layout-change 時回收殭屍項
    this._canvasObservers.set(view, cleanup);
    // 插件卸載時一併清理
    this.register(cleanup);
    processAll();
  }

  /* 冪等修復：每次掃描時清除 webview、補回缺失的卡片。
     已有卡片的節點是 no-op，成本只有一次 querySelector */
  // 切換 YouTube 設定後，提示使用者重開 Canvas。
  // 不做即時 DOM 切換——重開時讀新設定走對路徑，100% 可靠、無半套狀態。
  notifyCanvasYouTubeChange() {
    const hasOpenCanvasWithYouTube = this.app.workspace
      .getLeavesOfType('canvas')
      .some((leaf) => {
        const view = leaf.view;
        if (!view || !view.canvas) return false;
        let found = false;
        view.canvas.nodes?.forEach((node) => {
          try {
            const data = node.getData?.();
            if (data && data.type === 'link' && isYouTubeUrl(data.url)) found = true;
          } catch (e) {}
        });
        return found;
      });
    if (hasOpenCanvasWithYouTube) {
      new Notice('YouTube display setting changed. Reopen the canvas to apply it.');
    }
  }

  processCanvasNode(node) {
    try {
      const data = node.getData?.();
      if (!data || data.type !== 'link' || !data.url) return;

      const contentEl = node.contentEl
        || node.nodeEl?.querySelector('.canvas-node-content');
      if (!contentEl) return;

      // YouTube 且使用者選擇保留嵌入：不卡片化，維持原生 iframe 播放器
      if (isYouTubeUrl(data.url) && this.settings.youtubeCanvasEmbed) {
        const nodeEl = node.nodeEl || contentEl.closest('.canvas-node');
        if (nodeEl && nodeEl.classList) nodeEl.classList.remove('lcp-has-card');
        return;
      }

      const frames = contentEl.querySelectorAll('iframe, webview');
      frames.forEach((f) => {
        try { f.src = 'about:blank'; } catch (e) {}
        f.remove();
      });

      if (!contentEl.querySelector('.lcp-card')) {
        const url = data.url;
        // 標記節點：CSS 據此隱藏裸網址標籤（取代 has 偽類選擇器，效能較好）
        const nodeEl = node.nodeEl || contentEl.closest('.canvas-node');
        if (nodeEl && nodeEl.classList) nodeEl.classList.add('lcp-has-card');
        contentEl.textContent = '';
        const skeleton = createSkeleton(url);
        skeleton.classList.add('lcp-card--canvas');
        contentEl.appendChild(skeleton);
        fetchMeta(url).then((meta) => {
          renderCard(skeleton, url, meta, { canvas: true });
        });
      }
    } catch (e) {}
  }

}

class LinkCardSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Auto-insert Threads post text')
      .setDesc('When pasting a Threads link in the editor, fetch the post text and insert it on the line below the link.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.threadsPasteInsert)
          .onChange(async (value) => {
            this.plugin.settings.threadsPasteInsert = value;
            await this.plugin.saveData({
              cache: state.cache,
              settings: this.plugin.settings,
            });
          })
      );

    new Setting(containerEl)
      .setName('Embed YouTube in Canvas')
      .setDesc('Keep the native embedded player for YouTube links on Canvas instead of showing a link card. Other links are unaffected.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.youtubeCanvasEmbed)
          .onChange(async (value) => {
            this.plugin.settings.youtubeCanvasEmbed = value;
            await this.plugin.saveData({
              cache: state.cache,
              settings: this.plugin.settings,
            });
            this.plugin.notifyCanvasYouTubeChange();
          })
      );
  }
}

module.exports = LinkCardPlugin;
