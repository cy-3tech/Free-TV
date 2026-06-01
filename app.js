/* ============================================
   MyLo-TV — HIGH PERFORMANCE ENGINE
   Optimized for Fast Boot & On-Demand Streaming
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
  dataLoaded: false
};

const $ = id => document.getElementById(id);

// ---------- FAST INITIALIZATION ----------
async function init() {
  // 1. Show Loading
  showLoading('Initializing Grid...');

  // 2. Initialize Globe Immediately (Empty)
  initGlobe();

  // 3. Fetch Critical Data Only (Channels + Countries + Geo)
  // We SKIP streams.json and logos.json initially to save ~10MB of download
  try {
    const [chRes, coRes, geoRes] = await Promise.all([
      fetchWithCache('https://iptv-org.github.io/api/channels.json', 'channels_v1'),
      fetchWithCache('https://iptv-org.github.io/api/countries.json', 'countries_v1'),
      fetch('https://raw.githubusercontent.com/vasturiano/globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson')
    ]);

    const channels = await chRes.json();
    const countries = await coRes.json();
    const geoData = await geoRes.json();

    processData(channels, countries, geoData);
    
    state.dataLoaded = true;
    updateStats();
    hideLoading();

    // 4. Pre-fetch Logos in background (Low Priority)
    prefetchLogos();
  } catch (err) {
    console.error(err);
    $('loading-text').textContent = 'Connection Error';
    $('loading-sub').textContent = 'Retrying...';
    setTimeout(init, 2000);
  }
}

// Simple Cache Helper using localStorage
async function fetchWithCache(url, key) {
  const cached = localStorage.getItem(key);
  if (cached) {
    try {
      const data = JSON.parse(cached);
      // Return cached data immediately, but also fetch fresh in background? 
      // For simplicity, we return cache if < 24h old, else fetch new.
      // Here we just return cache to be FAST.
      return { json: () => Promise.resolve(data) };
    } catch(e) {}
  }
  
  const res = await fetch(url);
  const data = await res.json();
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch(e) { console.warn('Storage full'); }
  return { json: () => Promise.resolve(data) };
}

function processData(channels, countries, geoData) {
  // Index Countries
  countries.forEach(c => state.countryMeta.set(c.code, c));

  // Index Channels & Group by Country
  // We only index channels that HAVE a country code to save memory
  channels.forEach(ch => {
    if (!ch.country || !ch.id) return;
    
    // Store channel
    state.channelsById.set(ch.id, {
      id: ch.id,
      name: ch.name,
      country: ch.country.toUpperCase(),
      categories: ch.categories,
      logo: null, // Will be filled later
      streams: [] // Will be filled on demand
    });

    // Group by Country
    const code = ch.country.toUpperCase();    if (!state.channelsByCountry.has(code)) {
      state.channelsByCountry.set(code, []);
    }
    state.channelsByCountry.get(code).push(ch.id);
  });

  // Process GeoJSON
  state.geoFeatures = geoData.features.map(f => {
    const isoA2 = (f.properties.ISO_A2 || f.properties.ISO_A2_EH || '').toUpperCase();
    // Count channels for this country
    const count = state.channelsByCountry.has(isoA2) ? state.channelsByCountry.get(isoA2).length : 0;
    return {
      ...f,
      properties: { ...f.properties, isoA2, channelCount: count }
    };
  });

  // Update Globe Data
  if (state.globe) {
    state.globe.polygonsData(state.geoFeatures);
  }
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
    // Refresh sidebar if open
    if (state.currentCountry) {
      showCountryChannels(state.currentCountry, true);
    }
  } catch (e) { console.log('Logo prefetch failed', e); }
}

// ---------- ON-DEMAND STREAM FETCHING ----------
// This is the key to speed: We only fetch streams when user clicks a country
async function fetchStreamsForCountry(countryCode) {
  const countryChannels = state.channelsByCountry.get(countryCode);
  if (!countryChannels) return;

  // Check if we already have streams for most channels in this country
  const hasStreams = countryChannels.some(id => {
    const ch = state.channelsById.get(id);
    return ch && ch.streams && ch.streams.length > 0;
  });
  if (hasStreams) return; // Already loaded

  $('loading-sub').textContent = `Fetching streams for ${countryCode}...`;
  
  try {
    // Fetch ALL streams (this is heavy, but we do it once per country session)
    // Optimization: In a real app, you'd have a backend API. 
    // Here we fetch the global streams.json but filter locally.
    // To make it faster, we could fetch specific stream files if iptv-org supported it.
    // For now, we fetch the big file but cache it aggressively.
    
    const res = await fetchWithCache('https://iptv-org.github.io/api/streams.json', 'streams_v1');
    const allStreams = await res.json();

    // Map streams to our channels
    let count = 0;
    allStreams.forEach(s => {
      if (s.channel && state.channelsById.has(s.channel)) {
        // Only add if belongs to current country context (optional optimization)
        // But since streams.json doesn't have country, we map all.
        state.channelsById.get(s.channel).streams.push(s);
        count++;
      }
    });
    
    console.log(`Loaded ${count} streams globally`);
  } catch (e) {
    console.error("Failed to load streams", e);
  }
}

function updateStats() {
  let totalChannels = 0;
  state.channelsByCountry.forEach(arr => totalChannels += arr.length);
  const totalCountries = state.channelsByCountry.size;
  $('stats').textContent = `${totalChannels.toLocaleString()} Channels • ${totalCountries} Countries`;
}

// ---------- GLOBE ----------
function initGlobe() {
  const container = $('globe-container');

  const getColor = count => {
    if (count === 0) return 'rgba(18, 22, 35, 0.7)';
    const t = Math.min(Math.log(count + 1) / Math.log(400 + 1), 1);
    return `rgba(${Math.round(255 * t)}, ${Math.round(240 * (1-t))}, ${Math.round(255 * (1-t) + 110 * t)}, 0.8)`;
  };

  const globe = Globe()    .globeImageUrl('//unpkg.com/three-globe/example/img/earth-night.jpg')
    .backgroundImageUrl('//unpkg.com/three-globe/example/img/night-sky.png')
    .polygonsData([]) // Start empty
    .polygonAltitude(0.006)
    .polygonCapColor(f => getColor(f.properties.channelCount))
    .polygonSideColor(() => 'rgba(0,0,0,0.2)')
    .polygonStrokeColor(f => f.properties.channelCount > 0 ? 'rgba(0, 240, 255, 0.3)' : 'rgba(255,255,255,0.05)')
    .polygonLabel(f => `
      <div style="text-align:center">
        <strong>${f.properties.NAME || 'Unknown'}</strong><br>
        <span style="color:#8a9bb8">${f.properties.channelCount} Channels</span>
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
        .polygonAltitude(d => d === hoverD ? 0.04 : 0.006)
        .polygonCapColor(d => d === hoverD ? 'rgba(255, 215, 0, 0.9)' : getColor(d.properties.channelCount));
    })
    (container);

  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.4;
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
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(poly => ring(poly[0]));
  
  if (!total) return { lat: 0, lng: 0 };
  x /= total; y /= total; z /= total;  return {
    lng: Math.atan2(y, x) * 180 / Math.PI,
    lat: Math.atan2(z, Math.sqrt(x*x + y*y)) * 180 / Math.PI
  };
}

// ---------- SIDEBAR & UI ----------
async function showCountryChannels(code, refresh = false) {
  state.currentCountry = code;
  const country = state.countryMeta.get(code);
  const name = country ? `${country.flag || '🏳️'} ${country.name}` : code;
  
  $('sidebar-title').textContent = name;
  
  // If we haven't loaded streams for this country yet, fetch them now
  if (!refresh) {
    await fetchStreamsForCountry(code);
  }

  const channelIds = state.channelsByCountry.get(code) || [];
  const channels = channelIds.map(id => state.channelsById.get(id)).filter(Boolean);
  
  $('channel-count').textContent = `${channels.length} Channels`;
  $('filter-channels').value = '';
  
  renderChannelList(channels);
  $('sidebar').classList.remove('hidden');
  $('player-overlay').classList.add('hidden');
}

function renderChannelList(channels) {
  const ul = $('channels');
  ul.innerHTML = '';
  
  if (!channels.length) {
    ul.innerHTML = '<li class="empty">No channels found</li>';
    return;
  }

  // Sort by name
  channels.sort((a, b) => a.name.localeCompare(b.name));

  channels.forEach(ch => {
    const li = document.createElement('li');
    li.className = 'channel-item';
    li.dataset.name = ch.name.toLowerCase();

    const logoHtml = ch.logo
      ? `<img src="${ch.logo}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="logo-placeholder">${ch.name.charAt(0)}</div>`;
    const cats = ch.categories ? ch.categories.slice(0, 2).join(', ') : 'General';
    const streamCount = ch.streams ? ch.streams.length : 0;

    li.innerHTML = `
      <div class="channel-logo">${logoHtml}</div>
      <div class="channel-info">
        <div class="channel-name">${escapeHtml(ch.name)}</div>
        <div class="channel-meta">${cats} • ${streamCount} Streams</div>
      </div>
      <button class="play-btn" aria-label="Play">▶</button>
    `;

    li.querySelector('.play-btn').addEventListener('click', e => {
      e.stopPropagation();
      playChannel(ch);
    });
    li.addEventListener('click', () => playChannel(ch));
    ul.appendChild(li);
  });
}

// ---------- PLAYER ----------
function playChannel(channel, streamIndex = 0) {
  if (!channel.streams || channel.streams.length === 0) {
    alert('No streams available for this channel.');
    return;
  }

  state.currentChannel = channel;
  state.currentStreamIndex = streamIndex;
  const stream = channel.streams[streamIndex];

  $('current-channel-name').textContent = channel.name;
  $('player-meta').textContent = `${stream.quality || 'Live'} • ${channel.country}`;

  const logo = $('player-logo');
  if (channel.logo) {
    logo.src = channel.logo;
    logo.classList.remove('hidden');
  } else {
    logo.classList.add('hidden');
  }

  $('player-overlay').classList.remove('hidden');
  $('player-loader').classList.remove('hidden');
  $('stream-fallback').classList.add('hidden');
  $('player-error').classList.add('hidden');
  $('next-stream').classList.toggle('hidden', channel.streams.length <= 1);
  $('stream-indicator').textContent = `Stream ${streamIndex + 1} / ${channel.streams.length}`;
  // Destroy previous HLS instance
  if (state.hlsInstance) {
    state.hlsInstance.destroy();
    state.hlsInstance = null;
  }

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
        showPlayerError(true, 'Stream failed');
      }
    }, 1500);
  };

  if (Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90
    });
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      $('player-loader').classList.add('hidden');
      v.play().catch(e => console.log('Autoplay blocked', e));
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) onError();
    });
    state.hlsInstance = hls;
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = url;
    v.addEventListener('loadedmetadata', () => {
      $('player-loader').classList.add('hidden');
      v.play().catch(e => console.log('Autoplay blocked', e));
    }, { once: true });
    v.addEventListener('error', onError, { once: true });
  } else {
    showPlayerError(true, 'Browser not supported');  }
}

function closePlayer() {
  if (state.hlsInstance) {
    state.hlsInstance.destroy();
    state.hlsInstance = null;
  }
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

// ---------- SEARCH ----------
let searchDebounce;
$('search').addEventListener('input', e => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    $('search-results').classList.add('hidden');
    return;
  }
  searchDebounce = setTimeout(() => performSearch(q), 200);
});

function performSearch(query) {
  const results = [];
  
  // Search Countries
  state.countryMeta.forEach((c, code) => {
    if (c.name.toLowerCase().includes(query)) {
      results.push({ type: 'country', code, name: c.name, flag: c.flag });
    }
  });

  // Search Channels (Limit to 10 for speed)
  let count = 0;
  state.channelsById.forEach(ch => {
    if (count > 10) return;
    if (ch.name.toLowerCase().includes(query)) {      results.push({ type: 'channel', channel: ch });
      count++;
    }
  });

  if (results.length === 0) {
    $('search-results').innerHTML = '<div class="search-empty">No results</div>';
  } else {
    let html = '';
    results.forEach(r => {
      if (r.type === 'country') {
        html += `
          <div class="search-item" onclick="selectCountry('${r.code}')">
            <span class="search-flag">${r.flag}</span>
            <span>${escapeHtml(r.name)}</span>
          </div>`;
      } else {
        const ch = r.channel;
        html += `
          <div class="search-item" onclick="playChannelById('${ch.id}')">
            <div class="search-logo">${ch.logo ? `<img src="${ch.logo}">` : ch.name.charAt(0)}</div>
            <div>
              <div class="search-name">${escapeHtml(ch.name)}</div>
              <div class="search-meta">${ch.country}</div>
            </div>
          </div>`;
      }
    });
    $('search-results').innerHTML = html;
  }
  $('search-results').classList.remove('hidden');
}

// Global helpers for inline HTML onclicks
window.selectCountry = (code) => {
  const feat = state.geoFeatures.find(f => f.properties.isoA2 === code);
  if (feat) {
    const c = getCentroid(feat.geometry);
    state.globe.pointOfView({ lat: c.lat, lng: c.lng, altitude: 1.5 }, 1000);
  }
  showCountryChannels(code);
  $('search-results').classList.add('hidden');
  $('search').value = '';
};

window.playChannelById = (id) => {
  const ch = state.channelsById.get(id);
  if (ch) {
    // Ensure streams are loaded if possible, otherwise try to play
    if (!ch.streams || ch.streams.length === 0) {       // Trigger a global stream fetch if not done yet
       fetchStreamsForCountry(ch.country).then(() => {
         playChannel(ch);
       });
    } else {
      playChannel(ch);
    }
  }
  $('search-results').classList.add('hidden');
  $('search').value = '';
};

// ---------- EVENTS ----------
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

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function showLoading(text) {  $('loading-text').textContent = text;
  $('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  $('loading-overlay').classList.add('hidden');
}

// Start
init();
