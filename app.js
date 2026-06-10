/* ============================================
   MyLo-TV — UPGRADED ENGINE v2
   - Filters channels with 0 streams
   - Loads ALL streams on demand
   - Background particle canvas
   - Dynamic loading progress
   ============================================ */

const state = {
  channelsById: new Map(),
  channelsByCountry: new Map(),
  countryMeta: new Map(),
  geoFeatures: [],
  currentCountry: null,
  currentChannel: null,
  currentStreamIndex: 0,
  hlsInstance: null,
  globe: null,
  dataLoaded: false,
  streamsLoaded: false,
  allStreams: null // cache streams globally once fetched
};

const $ = id => document.getElementById(id);

// ============================================
// BACKGROUND PARTICLE CANVAS
// ============================================
function initParticles() {
  const canvas = document.getElementById('bg-canvas');
  const ctx = canvas.getContext('2d');
  let particles = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < 70; i++) {
    particles.push({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: Math.random() * 1.2 + 0.3,
      dx: (Math.random() - 0.5) * 0.25,
      dy: (Math.random() - 0.5) * 0.25,
      alpha: Math.random() * 0.5 + 0.1,
      color: Math.random() > 0.6 ? '#00f0ff' : Math.random() > 0.5 ? '#ff006e' : '#8b5cf6'
    });
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.fill();

      p.x += p.dx;
      p.y += p.dy;

      if (p.x < 0) p.x = canvas.width;
      if (p.x > canvas.width) p.x = 0;
      if (p.y < 0) p.y = canvas.height;
      if (p.y > canvas.height) p.y = 0;
    });
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  draw();
}

// ============================================
// INIT
// ============================================
async function init() {
  initParticles();
  setLoadingProgress(5, 'Initializing Grid...');
  initGlobe();

  try {
    setLoadingProgress(15, 'Loading channels...');
    const [chRes, coRes, geoRes] = await Promise.all([
      fetchWithCache('https://iptv-org.github.io/api/channels.json', 'channels_v2'),
      fetchWithCache('https://iptv-org.github.io/api/countries.json', 'countries_v2'),
      fetch('https://raw.githubusercontent.com/vasturiano/globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson')
    ]);

    setLoadingProgress(45, 'Processing channel data...');
    const channels = await chRes.json();
    const countries = await coRes.json();
    const geoData = await geoRes.json();

    setLoadingProgress(60, 'Mapping countries...');
    processData(channels, countries, geoData);

    setLoadingProgress(75, 'Fetching all stream data...');
    // Load streams upfront so we can filter channels with 0 streams
    await loadAllStreams();

    setLoadingProgress(90, 'Finalizing...');

    // After streams are loaded, remove channels with 0 streams
    filterChannelsWithNoStreams();

    // Rebuild country channel counts
    rebuildCountryCounts();

    state.dataLoaded = true;
    updateStats();

    setLoadingProgress(100, 'Ready!');
    setTimeout(hideLoading, 400);

    // Pre-fetch logos in background
    prefetchLogos();
  } catch (err) {
    console.error(err);
    $('loading-text').textContent = 'Connection Error — Retrying...';
    setTimeout(init, 3000);
  }
}

function setLoadingProgress(pct, msg) {
  const bar = $('loading-bar');
  if (bar) bar.style.width = pct + '%';
  if (msg) $('loading-text').textContent = msg;
}

// ============================================
// CACHE HELPER
// ============================================
async function fetchWithCache(url, key) {
  const cached = localStorage.getItem(key);
  if (cached) {
    try {
      const data = JSON.parse(cached);
      return { json: () => Promise.resolve(data) };
    } catch(e) {}
  }
  const res = await fetch(url);
  const data = await res.json();
  try { localStorage.setItem(key, JSON.stringify(data)); }
  catch(e) { console.warn('Storage full'); }
  return { json: () => Promise.resolve(data) };
}

// ============================================
// PROCESS DATA
// ============================================
function processData(channels, countries, geoData) {
  countries.forEach(c => state.countryMeta.set(c.code, c));

  channels.forEach(ch => {
    if (!ch.country || !ch.id) return;
    state.channelsById.set(ch.id, {
      id: ch.id,
      name: ch.name,
      country: ch.country.toUpperCase(),
      categories: ch.categories,
      logo: null,
      streams: []
    });
    const code = ch.country.toUpperCase();
    if (!state.channelsByCountry.has(code)) state.channelsByCountry.set(code, []);
    state.channelsByCountry.get(code).push(ch.id);
  });

  buildGeoFeatures(geoData);
}

function buildGeoFeatures(geoData) {
  state.geoFeatures = geoData.features.map(f => {
    const isoA2 = (f.properties.ISO_A2 || f.properties.ISO_A2_EH || '').toUpperCase();
    const count = state.channelsByCountry.has(isoA2) ? state.channelsByCountry.get(isoA2).length : 0;
    return { ...f, properties: { ...f.properties, isoA2, channelCount: count } };
  });
  if (state.globe) state.globe.polygonsData(state.geoFeatures);
}

// ============================================
// LOAD ALL STREAMS UPFRONT
// ============================================
async function loadAllStreams() {
  if (state.streamsLoaded && state.allStreams) return;
  try {
    const res = await fetchWithCache('https://iptv-org.github.io/api/streams.json', 'streams_v2');
    const allStreams = await res.json();
    state.allStreams = allStreams;

    let mapped = 0;
    allStreams.forEach(s => {
      if (s.channel && state.channelsById.has(s.channel)) {
        state.channelsById.get(s.channel).streams.push(s);
        mapped++;
      }
    });

    state.streamsLoaded = true;
    console.log(`Mapped ${mapped} streams to channels`);
  } catch(e) {
    console.error('Stream load failed:', e);
  }
}

// ============================================
// FILTER CHANNELS WITH NO STREAMS
// ============================================
function filterChannelsWithNoStreams() {
  let removed = 0;
  state.channelsById.forEach((ch, id) => {
    if (!ch.streams || ch.streams.length === 0) {
      state.channelsById.delete(id);
      removed++;
    }
  });
  // Also purge from country maps
  state.channelsByCountry.forEach((ids, code) => {
    const filtered = ids.filter(id => state.channelsById.has(id));
    if (filtered.length === 0) {
      state.channelsByCountry.delete(code);
    } else {
      state.channelsByCountry.set(code, filtered);
    }
  });
  console.log(`Removed ${removed} channels with 0 streams`);
}

function rebuildCountryCounts() {
  state.geoFeatures = state.geoFeatures.map(f => {
    const isoA2 = f.properties.isoA2;
    const count = state.channelsByCountry.has(isoA2) ? state.channelsByCountry.get(isoA2).length : 0;
    return { ...f, properties: { ...f.properties, channelCount: count } };
  });
  if (state.globe) state.globe.polygonsData(state.geoFeatures);
}

async function prefetchLogos() {
  try {
    const res = await fetch('https://iptv-org.github.io/api/logos.json');
    const logos = await res.json();
    logos.forEach(l => {
      if (state.channelsById.has(l.channel)) {
        state.channelsById.get(l.channel).logo = l.url;
      }
    });
    if (state.currentCountry) showCountryChannels(state.currentCountry, true);
  } catch(e) { console.log('Logo prefetch failed', e); }
}

function updateStats() {
  let total = 0;
  state.channelsByCountry.forEach(arr => total += arr.length);
  const countries = state.channelsByCountry.size;
  const txt = `${total.toLocaleString()} Channels • ${countries} Countries`;
  $('stats').textContent = txt;
  const hs = $('header-stats');
  if (hs) hs.textContent = txt;
}

// ============================================
// GLOBE
// ============================================
function initGlobe() {
  const container = $('globe-container');

  const getColor = count => {
    if (count === 0) return 'rgba(12, 14, 30, 0.65)';
    const t = Math.min(Math.log(count + 1) / Math.log(400 + 1), 1);
    const r = Math.round(255 * t);
    const g = Math.round(240 * (1 - t));
    const b = Math.round(255 * (1 - t) + 100 * t);
    return `rgba(${r}, ${g}, ${b}, 0.82)`;
  };

  const globe = Globe()
    .globeImageUrl('//unpkg.com/three-globe/example/img/earth-night.jpg')
    .backgroundImageUrl('//unpkg.com/three-globe/example/img/night-sky.png')
    .polygonsData([])
    .polygonAltitude(0.007)
    .polygonCapColor(f => getColor(f.properties.channelCount))
    .polygonSideColor(() => 'rgba(0,0,0,0.25)')
    .polygonStrokeColor(f =>
      f.properties.channelCount > 0 ? 'rgba(0, 240, 255, 0.3)' : 'rgba(255,255,255,0.04)'
    )
    .polygonLabel(f => `
      <div style="
        text-align:center;
        font-family:'Inter',sans-serif;
        background:rgba(8,10,24,0.97);
        border:1px solid rgba(0,240,255,0.3);
        border-radius:10px;
        padding:8px 14px;
        box-shadow:0 8px 24px rgba(0,0,0,0.5);
      ">
        <strong style="font-size:13px">${f.properties.NAME || 'Unknown'}</strong><br>
        <span style="color:#6a7a9b;font-size:11px">${f.properties.channelCount} Live Channels</span>
      </div>
    `)
    .onPolygonClick(f => {
      const code = f.properties.isoA2;
      if (state.channelsByCountry.has(code) && state.channelsByCountry.get(code).length > 0) {
        const centroid = getCentroid(f.geometry);
        globe.pointOfView({ lat: centroid.lat, lng: centroid.lng, altitude: 1.5 }, 800);
        showCountryChannels(code);
      }
    })
    .onPolygonHover(hoverD => {
      globe
        .polygonAltitude(d => d === hoverD ? 0.045 : 0.007)
        .polygonCapColor(d =>
          d === hoverD ? 'rgba(255, 215, 0, 0.92)' : getColor(d.properties.channelCount)
        );
    })
    (container);

  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.35;
  state.globe = globe;
}

function getCentroid(geometry) {
  let x = 0, y = 0, z = 0, total = 0;
  const ring = coords => {
    coords.forEach(([lng, lat]) => {
      const lr = lat * Math.PI / 180;
      const ln = lng * Math.PI / 180;
      x += Math.cos(lr) * Math.cos(ln);
      y += Math.cos(lr) * Math.sin(ln);
      z += Math.sin(lr);
      total++;
    });
  };
  if (geometry.type === 'Polygon') ring(geometry.coordinates[0]);
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(p => ring(p[0]));
  if (!total) return { lat: 0, lng: 0 };
  x /= total; y /= total; z /= total;
  return {
    lng: Math.atan2(y, x) * 180 / Math.PI,
    lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI
  };
}

// ============================================
// SIDEBAR
// ============================================
async function showCountryChannels(code, refresh = false) {
  state.currentCountry = code;
  const country = state.countryMeta.get(code);
  const name = country ? `${country.flag || '🏳️'} ${country.name}` : code;

  $('sidebar-title').textContent = name;

  const channelIds = state.channelsByCountry.get(code) || [];
  const channels = channelIds.map(id => state.channelsById.get(id)).filter(Boolean);

  $('channel-count').textContent = `${channels.length} Live Channels`;
  $('filter-channels').value = '';

  renderChannelList(channels);
  $('sidebar').classList.remove('hidden');
  $('player-overlay').classList.add('hidden');
}

function renderChannelList(channels) {
  const ul = $('channels');
  ul.innerHTML = '';

  if (!channels.length) {
    ul.innerHTML = '<li class="empty">📭 No channels with live streams</li>';
    return;
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));

  channels.forEach(ch => {
    const li = document.createElement('li');
    li.className = 'channel-item';
    li.dataset.name = ch.name.toLowerCase();

    const logoHtml = ch.logo
      ? `<img src="${ch.logo}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="logo-placeholder">${ch.name.charAt(0).toUpperCase()}</div>`;

    const cats = ch.categories ? ch.categories.slice(0, 2).join(', ') : 'General';
    const streamCount = ch.streams ? ch.streams.length : 0;

    li.innerHTML = `
      <div class="channel-logo">${logoHtml}</div>
      <div class="channel-info">
        <div class="channel-name">${escapeHtml(ch.name)}</div>
        <div class="channel-meta">${escapeHtml(cats)}</div>
        <span class="stream-count-badge">▶ ${streamCount} stream${streamCount !== 1 ? 's' : ''}</span>
      </div>
      <button class="play-btn" aria-label="Play ${escapeHtml(ch.name)}">▶</button>
    `;

    li.querySelector('.play-btn').addEventListener('click', e => {
      e.stopPropagation();
      playChannel(ch);
    });
    li.addEventListener('click', () => playChannel(ch));
    ul.appendChild(li);
  });
}

// ============================================
// PLAYER
// ============================================
function playChannel(channel, streamIndex = 0) {
  if (!channel.streams || channel.streams.length === 0) {
    alert('No live streams available for this channel.');
    return;
  }

  state.currentChannel = channel;
  state.currentStreamIndex = streamIndex;
  const stream = channel.streams[streamIndex];

  $('current-channel-name').textContent = channel.name;
  $('player-meta').textContent = `${stream.quality || 'Live'} • ${channel.country}`;

  const logo = $('player-logo');
  if (channel.logo) { logo.src = channel.logo; logo.classList.remove('hidden'); }
  else { logo.classList.add('hidden'); }

  $('player-overlay').classList.remove('hidden');
  $('player-loader').classList.remove('hidden');
  $('stream-fallback').classList.add('hidden');
  $('player-error').classList.add('hidden');
  $('next-stream').classList.toggle('hidden', channel.streams.length <= 1);
  $('stream-indicator').textContent = `Stream ${streamIndex + 1} / ${channel.streams.length}`;

  if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }

  const v = $('video-player');
  v.pause();
  v.removeAttribute('src');
  v.load();

  const url = stream.url;

  const onError = () => {
    $('stream-fallback').classList.remove('hidden');
    setTimeout(() => {
      if (state.currentChannel && streamIndex + 1 < state.currentChannel.streams.length) {
        playChannel(state.currentChannel, streamIndex + 1);
      } else {
        showPlayerError(true, 'All streams unavailable for this channel.');
      }
    }, 1500);
  };

  if (Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90,
      maxBufferLength: 30
    });
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      $('player-loader').classList.add('hidden');
      v.play().catch(e => console.log('Autoplay blocked', e));
    });
    hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) onError(); });
    state.hlsInstance = hls;
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = url;
    v.addEventListener('loadedmetadata', () => {
      $('player-loader').classList.add('hidden');
      v.play().catch(e => console.log('Autoplay blocked', e));
    }, { once: true });
    v.addEventListener('error', onError, { once: true });
  } else {
    showPlayerError(true, 'Browser does not support HLS streams.');
  }
}

function closePlayer() {
  if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
  const v = $('video-player');
  v.pause();
  v.removeAttribute('src');
  $('player-overlay').classList.add('hidden');
  state.currentChannel = null;
}

function showPlayerError(show, msg) {
  $('player-loader').classList.add('hidden');
  $('stream-fallback').classList.add('hidden');
  const err = $('player-error');
  err.classList.toggle('hidden', !show);
  if (msg) err.querySelector('p').textContent = '⚠️ ' + msg;
}

// ============================================
// SEARCH
// ============================================
let searchDebounce;
$('search').addEventListener('input', e => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim().toLowerCase();
  if (!q) { $('search-results').classList.add('hidden'); return; }
  searchDebounce = setTimeout(() => performSearch(q), 200);
});

function performSearch(query) {
  const results = [];

  state.countryMeta.forEach((c, code) => {
    if (c.name.toLowerCase().includes(query) && state.channelsByCountry.has(code)) {
      results.push({ type: 'country', code, name: c.name, flag: c.flag });
    }
  });

  let count = 0;
  state.channelsById.forEach(ch => {
    if (count > 12) return;
    if (ch.name.toLowerCase().includes(query)) {
      results.push({ type: 'channel', channel: ch });
      count++;
    }
  });

  if (!results.length) {
    $('search-results').innerHTML = '<div class="search-empty">No results found</div>';
  } else {
    let html = '';
    results.forEach(r => {
      if (r.type === 'country') {
        html += `<div class="search-item" onclick="selectCountry('${r.code}')">
          <span class="search-flag">${r.flag || '🏳️'}</span>
          <div>
            <div class="search-name">${escapeHtml(r.name)}</div>
            <div class="search-meta">${state.channelsByCountry.get(r.code)?.length || 0} channels</div>
          </div>
        </div>`;
      } else {
        const ch = r.channel;
        const sc = ch.streams ? ch.streams.length : 0;
        html += `<div class="search-item" onclick="playChannelById('${ch.id}')">
          <div class="search-logo">${ch.logo ? `<img src="${ch.logo}" onerror="this.style.display='none'">` : ch.name.charAt(0).toUpperCase()}</div>
          <div>
            <div class="search-name">${escapeHtml(ch.name)}</div>
            <div class="search-meta">${ch.country} • ${sc} stream${sc !== 1 ? 's' : ''}</div>
          </div>
        </div>`;
      }
    });
    $('search-results').innerHTML = html;
  }
  $('search-results').classList.remove('hidden');
}

window.selectCountry = code => {
  const feat = state.geoFeatures.find(f => f.properties.isoA2 === code);
  if (feat) {
    const c = getCentroid(feat.geometry);
    state.globe.pointOfView({ lat: c.lat, lng: c.lng, altitude: 1.5 }, 1000);
  }
  showCountryChannels(code);
  $('search-results').classList.add('hidden');
  $('search').value = '';
};

window.playChannelById = id => {
  const ch = state.channelsById.get(id);
  if (ch) playChannel(ch);
  $('search-results').classList.add('hidden');
  $('search').value = '';
};

// ============================================
// EVENTS
// ============================================
$('close-sidebar').addEventListener('click', () => $('sidebar').classList.add('hidden'));
$('close-player').addEventListener('click', closePlayer);
$('next-stream').addEventListener('click', () => {
  if (state.currentChannel) playChannel(state.currentChannel, state.currentStreamIndex + 1);
});
$('retry-stream').addEventListener('click', () => {
  if (state.currentChannel) playChannel(state.currentChannel, 0);
});
$('reset-view').addEventListener('click', () => {
  state.globe.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 1500);
});
$('filter-channels').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.channel-item').forEach(li => {
    li.style.display = li.dataset.name.includes(q) ? '' : 'none';
  });
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-box')) $('search-results').classList.add('hidden');
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closePlayer();
    $('sidebar').classList.add('hidden');
    $('search-results').classList.add('hidden');
  }
});

// ============================================
// HELPERS
// ============================================
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function hideLoading() {
  const overlay = $('loading-overlay');
  overlay.style.opacity = '0';
  setTimeout(() => overlay.classList.add('hidden'), 500);
}

// Start
init();
