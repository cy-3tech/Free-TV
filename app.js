/* ============================================
   TV.EVERYWHERE — GLOBAL STREAMING INTERFACE
   ============================================ */

// ---------- State ----------
const state = {
  channelsById: new Map(),
  channelsByCountry: new Map(),
  countryMeta: new Map(),
  logosByChannel: new Map(),
  geoFeatures: [],
  currentCountry: null,
  currentChannel: null,
  currentStreamIndex: 0,
  hlsInstance: null,
  globe: null,
  isFiltering: false
};

// ---------- DOM Helpers ----------
const $ = id => document.getElementById(id);

// ---------- Data Loading ----------
async function init() {
  showLoading('Connecting to IPTV database...');
  try {
    const [chRes, stRes, coRes, lgRes, geoRes] = await Promise.all([
      fetch('https://iptv-org.github.io/api/channels.json'),
      fetch('https://iptv-org.github.io/api/streams.json'),
      fetch('https://iptv-org.github.io/api/countries.json'),
      fetch('https://iptv-org.github.io/api/logos.json'),
      fetch('https://raw.githubusercontent.com/vasturiano/globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson')
    ]);

    const channels = await chRes.json();
    const streams = await stRes.json();
    const countries = await coRes.json();
    const logos = await lgRes.json();
    const geoData = await geoRes.json();

    processData(channels, streams, countries, logos, geoData);
    initGlobe();
    updateStats();
    hideLoading();
  } catch (err) {
    console.error(err);
    $('loading-text').textContent = 'Connection failed.';
    $('loading-sub').textContent = 'Retrying in 3 seconds...';
    setTimeout(init, 3000);
  }
}

function processData(channels, streams, countries, logos, geoData) {
  // Country metadata
  countries.forEach(c => state.countryMeta.set(c.code, c));

  // Logos (first per channel)
  logos.forEach(l => {
    if (!state.logosByChannel.has(l.channel)) {
      state.logosByChannel.set(l.channel, l.url);
    }
  });

  // Channels
  channels.forEach(ch => {
    state.channelsById.set(ch.id, {
      ...ch,
      streams: [],
      logo: state.logosByChannel.get(ch.id) || null
    });
  });

  // Attach streams
  streams.forEach(s => {
    if (s.channel && state.channelsById.has(s.channel)) {
      state.channelsById.get(s.channel).streams.push(s);
    }
  });

  // Group by country (only channels with streams)
  state.channelsById.forEach(ch => {
    if (ch.streams.length === 0) return;
    const code = (ch.country || 'XX').toUpperCase();
    if (!state.channelsByCountry.has(code)) {
      state.channelsByCountry.set(code, []);
    }
    state.channelsByCountry.get(code).push(ch);
  });

  // Enrich GeoJSON with channel counts
  state.geoFeatures = geoData.features.map(f => {
    const isoA2 = (f.properties.ISO_A2 || f.properties.ISO_A2_EH || '').toUpperCase();
    const count = state.channelsByCountry.has(isoA2) ? state.channelsByCountry.get(isoA2).length : 0;
    return {
      ...f,
      properties: {
        ...f.properties,
        isoA2,
        channelCount: count
      }
    };
  });
}

function updateStats() {
  let totalChannels = 0;
  state.channelsByCountry.forEach(arr => totalChannels += arr.length);
  const totalCountries = state.channelsByCountry.size;
  $('stats').textContent = `${totalChannels.toLocaleString()} channels • ${totalCountries} countries`;
}

// ---------- Globe ----------
function initGlobe() {
  const container = $('globe-container');

  const getColor = count => {
    if (count === 0) return 'rgba(18, 22, 35, 0.7)';
    const max = 400;
    const t = Math.min(Math.log(count + 1) / Math.log(max + 1), 1);
    const r = Math.round(0 + 255 * t);
    const g = Math.round(240 + (0 - 240) * t);
    const b = Math.round(255 + (110 - 255) * t);
    return `rgba(${r}, ${g}, ${b}, 0.82)`;
  };

  const globe = Globe()
    .globeImageUrl('//unpkg.com/three-globe/example/img/earth-night.jpg')
    .backgroundImageUrl('//unpkg.com/three-globe/example/img/night-sky.png')
    .polygonsData(state.geoFeatures)
    .polygonAltitude(0.006)
    .polygonCapColor(f => getColor(f.properties.channelCount))
    .polygonSideColor(() => 'rgba(0, 0, 0, 0.25)')
    .polygonStrokeColor(f => f.properties.channelCount > 0 ? 'rgba(0, 240, 255, 0.35)' : 'rgba(255,255,255,0.04)')
    .polygonLabel(f => {
      const name = f.properties.NAME || f.properties.ADMIN || 'Unknown';
      const count = f.properties.channelCount;
      return `
        <div style="text-align:center">
          <strong>${escapeHtml(name)}</strong>
          <span style="display:block;color:#8a9bb8;font-size:12px;margin-top:2px">
            ${count} channel${count !== 1 ? 's' : ''}
          </span>
        </div>
      `;
    })
    .onPolygonClick(f => {
      const code = f.properties.isoA2;
      if (state.channelsByCountry.has(code) && state.channelsByCountry.get(code).length > 0) {
        const centroid = getCentroid(f.geometry);
        globe.pointOfView({ lat: centroid.lat, lng: centroid.lng, altitude: 1.6 }, 1000);
        showCountryChannels(code);
      }
    })
    .onPolygonHover(hoverD => {
      globe
        .polygonAltitude(d => d === hoverD ? 0.05 : 0.006)
        .polygonCapColor(d => {
          if (d === hoverD) return 'rgba(255, 215, 0, 0.9)';
          return getColor(d.properties.channelCount);
        });
    })
    .polygonsTransitionDuration(250)
    (container);

  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.5;

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

  if (geometry.type === 'Polygon') {
    ring(geometry.coordinates[0]);
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach(poly => ring(poly[0]));
  }

  if (!total) return { lat: 0, lng: 0 };

  x /= total; y /= total; z /= total;
  return {
    lng: Math.atan2(y, x) * 180 / Math.PI,
    lat: Math.atan2(z, Math.sqrt(x*x + y*y)) * 180 / Math.PI
  };
}

// ---------- Sidebar ----------
function showCountryChannels(code) {
  const channels = state.channelsByCountry.get(code) || [];
  const country = state.countryMeta.get(code);
  const name = country ? `${country.flag || '🏳️'} ${country.name}` : code;

  state.currentCountry = code;
  $('sidebar-title').textContent = name;
  $('channel-count').textContent = `${channels.length} channel${channels.length !== 1 ? 's' : ''}`;
  $('filter-channels').value = '';

  renderChannelList(channels);
  $('sidebar').classList.remove('hidden');
  $('player-overlay').classList.add('hidden');
}

function renderChannelList(channels) {
  const ul = $('channels');
  ul.innerHTML = '';

  if (!channels.length) {
    ul.innerHTML = '<li class="empty">No channels available</li>';
    return;
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));

  channels.forEach(ch => {
    const li = document.createElement('li');
    li.className = 'channel-item';
    li.dataset.name = ch.name.toLowerCase();

    const logoHtml = ch.logo
      ? `<img src="${ch.logo}" alt="" loading="lazy" onerror="this.style.display='none';this.parentNode.innerHTML='<div class=\\'logo-placeholder\\'>${ch.name[0]}</div>'">`
      : `<div class="logo-placeholder">${ch.name[0]}</div>`;

    const cats = ch.categories?.slice(0, 2).join(', ') || 'General';
    const streamCount = ch.streams.length;

    li.innerHTML = `
      <div class="channel-logo">${logoHtml}</div>
      <div class="channel-info">
        <div class="channel-name">${escapeHtml(ch.name)}</div>
        <div class="channel-meta">${cats} • ${streamCount} stream${streamCount !== 1 ? 's' : ''}</div>
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

// ---------- Player ----------
function playChannel(channel, streamIndex = 0) {
  state.currentChannel = channel;
  state.currentStreamIndex = streamIndex;

  if (streamIndex >= channel.streams.length) {
    showPlayerError(true);
    return;
  }

  const stream = channel.streams[streamIndex];

  $('current-channel-name').textContent = channel.name;
  $('player-meta').textContent = [
    stream.quality || 'Unknown quality',
    state.countryMeta.get(channel.country)?.name || channel.country || 'N/A',
    stream.title
  ].filter(Boolean).join(' • ');

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

  // Cleanup previous
  if (state.hlsInstance) {
    state.hlsInstance.destroy();
    state.hlsInstance = null;
  }
  const v = $('video-player');
  v.pause();
  v.removeAttribute('src');
  v.load();

  const url = stream.url;

  const onFatal = () => {
    if (!state.currentChannel) return;
    $('stream-fallback').classList.remove('hidden');
    setTimeout(() => playChannel(channel, streamIndex + 1), 1200);
  };

  if (Hls.isSupported()) {
    const hls = new Hls({
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      enableWorker: true,
      xhrSetup: xhr => {
        if (stream.referrer) xhr.setRequestHeader('Referer', stream.referrer);
      }
    });
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      $('player-loader').classList.add('hidden');
      v.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) onFatal();
    });
    state.hlsInstance = hls;
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = url;
    v.addEventListener('loadedmetadata', () => {
      $('player-loader').classList.add('hidden');
      v.play().catch(() => {});
    }, { once: true });
    v.addEventListener('error', onFatal, { once: true });
  } else {
    showPlayerError(true, 'HLS not supported in this browser.');
  }
}

function closePlayer() {
  if (state.hlsInstance) {
    state.hlsInstance.destroy();
    state.hlsInstance = null;
  }
  const v = $('video-player');
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('player-overlay').classList.add('hidden');
  state.currentChannel = null;
  state.currentStreamIndex = 0;
}

function showPlayerError(show, msg) {
  $('player-loader').classList.add('hidden');
  $('stream-fallback').classList.add('hidden');
  const err = $('player-error');
  err.classList.toggle('hidden', !show);
  if (msg) err.querySelector('p').textContent = '⚠️ ' + msg;
}

// ---------- Search ----------
let searchDebounce;
$('search').addEventListener('input', e => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    $('search-results').classList.add('hidden');
    return;
  }
  searchDebounce = setTimeout(() => performSearch(q), 180);
});

function performSearch(query) {
  const countries = [];
  const channels = [];

  state.countryMeta.forEach((c, code) => {
    if (c.name.toLowerCase().includes(query) || code.toLowerCase().includes(query)) {
      countries.push({ type: 'country', code, name: c.name, flag: c.flag });
    }
  });

  state.channelsById.forEach(ch => {
    if (ch.streams.length === 0) return;
    const nameMatch = ch.name.toLowerCase().includes(query);
    const altMatch = ch.alt_names?.some(n => n.toLowerCase().includes(query));
    if (nameMatch || altMatch) {
      channels.push({ type: 'channel', channel: ch });
    }
  });

  const cSlice = countries.slice(0, 5);
  const chSlice = channels.slice(0, 10);

  if (!cSlice.length && !chSlice.length) {
    $('search-results').innerHTML = '<div class="search-empty">No results found</div>';
    $('search-results').classList.remove('hidden');
    return;
  }

  let html = '';
  if (cSlice.length) {
    html += '<div class="search-section">Countries</div>';
    cSlice.forEach(c => {
      html += `
        <div class="search-item" data-type="country" data-code="${c.code}">
          <span class="search-flag">${c.flag || '🏳️'}</span>
          <span>${escapeHtml(c.name)}</span>
        </div>`;
    });
  }
  if (chSlice.length) {
    html += '<div class="search-section">Channels</div>';
    chSlice.forEach(c => {
      const ch = c.channel;
      html += `
        <div class="search-item" data-type="channel" data-id="${ch.id}">
          <div class="search-logo">
            ${ch.logo ? `<img src="${ch.logo}" alt="" loading="lazy">` : ch.name[0]}
          </div>
          <div>
            <div class="search-name">${escapeHtml(ch.name)}</div>
            <div class="search-meta">${state.countryMeta.get(ch.country)?.name || ch.country} • ${ch.categories?.[0] || 'General'}</div>
          </div>
        </div>`;
    });
  }

  $('search-results').innerHTML = html;
  $('search-results').classList.remove('hidden');

  $('search-results').querySelectorAll('.search-item').forEach(item => {
    item.addEventListener('click', () => {
      if (item.dataset.type === 'country') {
        const code = item.dataset.code;
        const feat = state.geoFeatures.find(f => f.properties.isoA2 === code);
        if (feat) {
          const c = getCentroid(feat.geometry);
          state.globe.pointOfView({ lat: c.lat, lng: c.lng, altitude: 1.6 }, 1000);
        }
        showCountryChannels(code);
      } else {
        const ch = state.channelsById.get(item.dataset.id);
        if (ch) playChannel(ch);
      }
      $('search-results').classList.add('hidden');
      $('search').value = '';
    });
  });
}

// Sidebar filter
$('filter-channels').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.channel-item').forEach(li => {
    li.style.display = li.dataset.name.includes(q) ? '' : 'none';
  });
});

// ---------- Events ----------
$('close-sidebar').addEventListener('click', () => {
  $('sidebar').classList.add('hidden');
  state.currentCountry = null;
});

$('close-player').addEventListener('click', closePlayer);

$('next-stream').addEventListener('click', () => {
  if (state.currentChannel) {
    playChannel(state.currentChannel, state.currentStreamIndex + 1);
  }
});

$('retry-stream').addEventListener('click', () => {
  if (state.currentChannel) {
    playChannel(state.currentChannel, 0);
  }
});

$('reset-view').addEventListener('click', () => {
  state.globe.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 1500);
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-box')) {
    $('search-results').classList.add('hidden');
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closePlayer();
    $('sidebar').classList.add('hidden');
    $('search-results').classList.add('hidden');
  }
});

// ---------- Utils ----------
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function showLoading(text) {
  $('loading-text').textContent = text;
  $('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  $('loading-overlay').classList.add('hidden');
}

// ---------- Boot ----------
init();
