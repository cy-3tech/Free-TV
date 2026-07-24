// ============================================
// SUPABASE CONFIGURATION
// ============================================
const SUPABASE_URL = 'https://gothdzitnhoexqzjhgdz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdvdGhkeml0bmhvZXhxempoZGd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyOTUwMjAsImV4cCI6MjA5OTg3MTAyMH0.RnogiDlvNvQJhkxP7BYvJWbJRaWJkN_hyOvylJGmiXc';

// Initialize Supabase Client
let supabase = null;
if (typeof window.supabase !== 'undefined') {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// Get User ID from HTML inline script
const myloUserId = localStorage.getItem('mylo_user_id');

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
    allStreams: null,
    favorites: [] // Will be loaded from Supabase
};

const $ = id => document.getElementById(id);

// ============================================
// SUPABASE FAVORITES LOGIC
// ============================================
async function loadFavoritesFromSupabase() {
    if (!supabase || !myloUserId) return [];
    try {
        const { data, error } = await supabase
            .from('favorites')
            .select('channel_id')
            .eq('user_id', myloUserId);
        
        if (error) throw error;
        return data.map(item => ({ id: item.channel_id }));
    } catch (e) {
        console.error('Error loading favorites:', e);
        return [];
    }
}

async function saveFavoriteToSupabase(channelId) {
    if (!supabase || !myloUserId) return;
    try {
        const { error } = await supabase
            .from('favorites')
            .insert({ user_id: myloUserId, channel_id: channelId });
        
        if (error && error.code !== '23505') { // Ignore duplicate key errors
            console.error('Error saving favorite:', error);
        }
    } catch (e) {
        console.error('Error saving favorite:', e);
    }
}

async function removeFavoriteFromSupabase(channelId) {
    if (!supabase || !myloUserId) return;
    try {
        const { error } = await supabase
            .from('favorites')
            .delete()
            .eq('user_id', myloUserId)
            .eq('channel_id', channelId);
        
        if (error) console.error('Error removing favorite:', error);
    } catch (e) {
        console.error('Error removing favorite:', e);
    }
}

// ============================================
// A NOTE ON CHANNEL SOURCING
// ============================================
// This app sources ALL channel + stream metadata from the community-maintained,
// continuously-updated iptv-org public dataset (channels.json / streams.json /
// logos.json). This already covers every country's free-to-air / publicly
// streamable channels, so there is no need to hand-maintain per-country lists.
//
// South Africa's free-to-air channels (SABC 1/2/3, SABC News, SABC Sport,
// e.tv, eExtra, eMovies, OpenView HD channels such as 1Magic-adjacent FTA
// carriers, Mindset, Cbeebies-style kids feeds, etc.) come through the same
// pipeline below and are tagged where possible — see tagOpenViewChannels().
//
// DStv is intentionally NOT included. DStv is MultiChoice's subscription
// satellite service, delivered with proprietary DRM/encryption. There is no
// legitimate free public stream endpoint for DStv channels, so adding "DStv"
// entries here would necessarily mean either fake/non-functional URLs or
// unauthorized/pirated feeds. Neither is something this app will ship.
//
// Every channel from the dataset is shown immediately — there is no
// pre-flight network check before a channel appears. If a stream turns out
// to be dead when someone actually presses play, playWithAntiBlock() (below)
// automatically retries the channel's other candidate URLs/fallbacks, so bad
// links get handled at play time instead of at load time.

// Tag OpenView HD's known free-to-air channel names within South Africa so
// they're easy to find/filter, without inventing stream data for them — the
// underlying URLs still come from the same public dataset as everything else.
const OPENVIEW_NAME_PATTERNS = [
    /openview/i, /1magic/i, /moja\s?love/i, /a24/i, /rezolusie/i, /pop\s?tv/i, /soweto\s?tv/i, /dumelang/i
];

function tagOpenViewChannels() {
    const zaIds = state.channelsByCountry.get('ZA') || [];
    zaIds.forEach(id => {
        const ch = state.channelsById.get(id);
        if (!ch) return;
        const isOpenView = OPENVIEW_NAME_PATTERNS.some(re => re.test(ch.name));
        if (isOpenView) {
            ch.categories = Array.from(new Set([...(ch.categories || []), 'openview']));
        }
    });
}

// ============================================
// STREAM ANTI-BLOCK / ROTATOR SYSTEM
// ============================================
function getRotatedStreams(channel) {
    if (!channel.streams || channel.streams.length === 0) return [];
    return channel.streams.map((stream, idx) => {
        const base = { ...stream, originalUrl: stream.url };
        if (idx === 0) {
          base.fallbackUrls = [
            stream.url,
            stream.url.replace('http://', 'https://'),
            stream.url.replace(/\/playlist\.m3u8$/, '/index.m3u8'),
            stream.url.replace(/\/stream\.m3u8$/, '/playlist.m3u8')
          ];
        }
        base.cacheBustedUrl = stream.url.includes('?')
          ? `${stream.url}&t=${Date.now()}`
          : `${stream.url}?t=${Date.now()}`;
        return base;
    });
}

async function playWithAntiBlock(channel, streamIndex = 0, attempt = 0) {
    if (!channel.streams || channel.streams.length === 0) {
        showToast('No live streams available.');
        return;
    }

    state.currentChannel = channel;
    state.currentStreamIndex = streamIndex;

    const rotatedStreams = getRotatedStreams(channel);
    if (streamIndex >= rotatedStreams.length) streamIndex = 0;

    const stream = rotatedStreams[streamIndex];
    const urlsToTry = [stream.cacheBustedUrl, ...(stream.fallbackUrls || [])];

    // Update UI safely
    try {
        const nameEl = $('current-channel-name');
        const metaEl = $('player-meta');
        const logo = $('player-logo');
        const overlay = $('player-overlay');
        const loader = $('player-loader');
        const fallback = $('stream-fallback');
        const errorEl = $('player-error');
        const nextBtn = $('next-stream');
        const indicator = $('stream-indicator');

        if (nameEl) nameEl.textContent = channel.name;
        if (metaEl) metaEl.textContent = `${stream.quality || 'Live'} • ${channel.country} • Anti-Block Active`;
        
        if (logo) {
          if (channel.logo) { logo.src = channel.logo; logo.classList.remove('hidden'); }
          else { logo.classList.add('hidden'); }
        }
        if (overlay) overlay.classList.remove('hidden');
        if (loader) loader.classList.remove('hidden');
        if (fallback) fallback.classList.add('hidden');
        if (errorEl) errorEl.classList.add('hidden');
        if (nextBtn) nextBtn.classList.toggle('hidden', rotatedStreams.length <= 1);
        if (indicator) indicator.textContent = `Stream ${streamIndex + 1} / ${rotatedStreams.length} | Attempt ${attempt + 1}`;
    } catch (e) { console.error('UI update error:', e); }

    updatePlayerFavButton();

    if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
    const v = $('video-player');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }

    let urlIndex = 0;
    let loadTimeout = null;

    const tryNextUrl = () => {
        if (loadTimeout) clearTimeout(loadTimeout);
        
        if (urlIndex >= urlsToTry.length) {
           if (streamIndex + 1 < rotatedStreams.length && attempt < 3) {
             console.log(`Anti-Block: Switching to next stream (${streamIndex + 1})`);
             playWithAntiBlock(channel, streamIndex + 1, attempt + 1);
           } else {
             showPlayerError(true, 'All streams blocked. Try again later.');
           }
           return;
         }

         const url = urlsToTry[urlIndex];
         console.log(`Anti-Block: Trying URL ${urlIndex + 1}/${urlsToTry.length}`);

         // Timeout protection - if no manifest parsed in 10s, move on
         loadTimeout = setTimeout(() => {
           console.warn(`⏱️ Load timeout for URL ${urlIndex + 1}, trying next...`);
           urlIndex++;
           tryNextUrl();
         }, 10000);

         const onError = () => {
           if (loadTimeout) clearTimeout(loadTimeout);
           urlIndex++;
           if (urlIndex < urlsToTry.length) {
             setTimeout(tryNextUrl, 1000);
           } else {
             if (streamIndex + 1 < rotatedStreams.length) {
               playWithAntiBlock(channel, streamIndex + 1, attempt + 1);
             } else {
               showPlayerError(true, 'All streams unavailable or blocked.');
             }
           }
         };

         try {
           if (typeof Hls !== 'undefined' && Hls.isSupported()) {
             const hls = new Hls({
               enableWorker: true,
               lowLatencyMode: true,
               backBufferLength: 90,
               maxBufferLength: 30,
               xhrSetup: (xhr) => {
                 xhr.setRequestHeader('Referer', window.location.origin);
                 xhr.setRequestHeader('Origin', window.location.origin);
               }
             });
             hls.loadSource(url);
             hls.attachMedia(v);
             hls.on(Hls.Events.MANIFEST_PARSED, () => {
               if (loadTimeout) clearTimeout(loadTimeout);
               const l = $('player-loader'); if (l) l.classList.add('hidden');
               v.play().catch(() => {});
             });
             hls.on(Hls.Events.ERROR, (_, data) => {
               if (data.fatal) onError();
             });
             state.hlsInstance = hls;
           } else if (v && v.canPlayType('application/vnd.apple.mpegurl')) {
             v.src = url;
             v.addEventListener('loadedmetadata', () => {
               if (loadTimeout) clearTimeout(loadTimeout);
               const l = $('player-loader'); if (l) l.classList.add('hidden');
               v.play().catch(() => {});
             }, { once: true });
             v.addEventListener('error', onError, { once: true });
           } else {
             showPlayerError(true, 'Browser does not support HLS streams.');
           }
         } catch (e) {
           console.error('Player init error:', e);
           onError();
         }
    };

    tryNextUrl();
}

function playChannel(channel, streamIndex = 0) {
    playWithAntiBlock(channel, streamIndex, 0);
}

// ============================================
// TRACKING  & AUTO PACKAGE.JSON
// ============================================
function initTracking() {
    try {
        const STORAGE_KEY = 'mylo_tv_package_json';
        let packageData = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {
            name: "mylo-tv-webapp", version: "3.5.0",
            description: "Global Free TV Streaming Platform with Anti-Block",
            author: "DTGOdev", license: "MIT",
            stats: { 
                totalViews: 0, uniqueUsers: 0, 
                firstVisit: new Date().toISOString(), 
                lastVisit: new Date().toISOString(),
                userFingerprint: myloUserId 
            }
        };

        packageData.stats.totalViews++;
        packageData.stats.lastVisit = new Date().toISOString();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(packageData));
        
        updateVisibleCounter(packageData.stats);
    } catch (e) { console.warn('Tracking init failed:', e); }
}

function updateVisibleCounter(stats) {
    const counterEl = $('view-counter');
    if (counterEl && stats) {
        counterEl.textContent = `👁️ ${stats.totalViews.toLocaleString()} Views • 👤 ${stats.uniqueUsers.toLocaleString()} Users`;
    }
}

// ============================================
// BACKGROUND PARTICLE CANVAS
// ============================================
function initParticles() {
    const canvas = document.getElementById('bg-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let particles = [];

    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
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
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = p.color; ctx.globalAlpha = p.alpha; ctx.fill();
            p.x += p.dx; p.y += p.dy;
            if (p.x < 0) p.x = canvas.width; if (p.x > canvas.width) p.x = 0;
            if (p.y < 0) p.y = canvas.height; if (p.y > canvas.height) p.y = 0;
        });
        ctx.globalAlpha = 1; requestAnimationFrame(draw);
    }
    draw();
}

// ============================================
// CACHE HELPER
// ============================================
async function fetchWithCache(url, key) {
    const cached = localStorage.getItem(key);
    if (cached) { try { const data = JSON.parse(cached); return { json: () => Promise.resolve(data) }; } catch(e) {} }
    const res = await fetch(url); const data = await res.json();
    try { localStorage.setItem(key, JSON.stringify(data)); } catch(e) { console.warn('Storage full'); }
    return { json: () => Promise.resolve(data) };
}

// ============================================
// PROCESS DATA
// ============================================
function processData(channels, countries, geoData) {
    countries.forEach(c => state.countryMeta.set(c.code, c));
    channels.forEach(ch => {
        if (!ch.country || !ch.id) return;
        state.channelsById.set(ch.id, { id: ch.id, name: ch.name, country: ch.country.toUpperCase(), categories: ch.categories, logo: null, streams: [] });
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
        console.log(`Mapped ${mapped} public streams across all countries`);
    } catch(e) { console.error('Stream load failed:', e); }
}

function filterChannelsWithNoStreams() {
    let removed = 0;
    state.channelsById.forEach((ch, id) => {
        if (!ch.streams || ch.streams.length === 0) { state.channelsById.delete(id); removed++; }
    });
    state.channelsByCountry.forEach((ids, code) => {
        const filtered = ids.filter(id => state.channelsById.has(id));
        if (filtered.length === 0) state.channelsByCountry.delete(code);
        else state.channelsByCountry.set(code, filtered);
    });
    console.log(`Removed ${removed} channels with 0 candidate streams`);
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
        logos.forEach(l => { if (state.channelsById.has(l.channel)) state.channelsById.get(l.channel).logo = l.url; });
        if (state.currentCountry) showCountryChannels(state.currentCountry, true);
        renderFavorites();
    } catch(e) { console.log('Logo prefetch failed', e); }
}

function updateStats() {
    let total = 0;
    state.channelsByCountry.forEach(arr => total += arr.length);
    const countries = state.channelsByCountry.size;
    const txt = `${total.toLocaleString()} Channels • ${countries} Countries`;
    const statsEl = $('stats'); if (statsEl) statsEl.textContent = txt;
    const hs = $('header-stats'); if (hs) hs.textContent = txt;
}

// ============================================
// GLOBE
// ============================================
function initGlobe() {
    const container = $('globe-container');
    if (!container) return;

    const getColor = count => {
        if (count === 0) return 'rgba(12, 14, 30, 0.65)';
        const t = Math.min(Math.log(count + 1) / Math.log(400 + 1), 1);
        return `rgba(${Math.round(255*t)}, ${Math.round(240*(1-t))}, ${Math.round(255*(1-t)+100*t)}, 0.82)`;
    };

    const globe = Globe()
        .globeImageUrl('//unpkg.com/three-globe/example/img/earth-night.jpg')
        .backgroundImageUrl('//unpkg.com/three-globe/example/img/night-sky.png')
        .polygonsData([])
        .polygonAltitude(0.007)
        .polygonCapColor(f => getColor(f.properties.channelCount))
        .polygonSideColor(() => 'rgba(0,0,0,0.25)')
        .polygonStrokeColor(f => f.properties.channelCount > 0 ? 'rgba(0,240,255,0.3)' : 'rgba(255,255,255,0.04)')
        .polygonLabel(f => `<div style="text-align:center;font-family:'Inter',sans-serif;background:rgba(8,10,24,0.97);border:1px solid rgba(0,240,255,0.3);border-radius:10px;padding:8px 14px;box-shadow:0 8px 24px rgba(0,0,0,0.5);"><strong style="font-size:13px">${f.properties.NAME||'Unknown'}</strong><br><span style="color:#6a7a9b;font-size:11px">${f.properties.channelCount} Live Channels</span></div>`)
        .onPolygonClick(f => {
            const code = f.properties.isoA2;
            if (state.channelsByCountry.has(code) && state.channelsByCountry.get(code).length > 0) {
                const centroid = getCentroid(f.geometry);
                globe.pointOfView({ lat: centroid.lat, lng: centroid.lng, altitude: 1.5 }, 800);
                showCountryChannels(code);
            }
        })
        .onPolygonHover(hoverD => {
            globe.polygonAltitude(d => d === hoverD ? 0.045 : 0.007)
            .polygonCapColor(d => d === hoverD ? 'rgba(255,215,0,0.92)' : getColor(d.properties.channelCount));
        })(container);

    globe.controls().autoRotate = true;
    globe.controls().autoRotateSpeed = 0.35;
    state.globe = globe;
}

function getCentroid(geometry) {
    let x=0,y=0,z=0,total=0;
    const ring = coords => coords.forEach(([lng,lat]) => {
        const lr=lat*Math.PI/180, ln=lng*Math.PI/180;
        x+=Math.cos(lr)*Math.cos(ln); y+=Math.cos(lr)*Math.sin(ln); z+=Math.sin(lr); total++;
    });
    if (geometry.type==='Polygon') ring(geometry.coordinates[0]);
    else if (geometry.type==='MultiPolygon') geometry.coordinates.forEach(p=>ring(p[0]));
    if (!total) return {lat:0,lng:0};
    x/=total; y/=total; z/=total;
    return { lng:Math.atan2(y,x)*180/Math.PI, lat:Math.atan2(z,Math.sqrt(x*x+y*y))*180/Math.PI };
}

// ============================================
// SIDEBAR & CHANNEL LIST
// ============================================
function showCountryChannels(code, refresh=false) {
    state.currentCountry = code;
    const country = state.countryMeta.get(code);
    const name = country ? `${country.flag||'🏳️'} ${country.name}` : code;
    const titleEl = $('sidebar-title'); if (titleEl) titleEl.textContent = name;
    
    const sidebar=$('sidebar'), favSidebar=$('favorites-sidebar'), playerOverlay=$('player-overlay');
    if (sidebar) sidebar.classList.remove('hidden');
    if (favSidebar) favSidebar.classList.add('hidden');
    if (playerOverlay) playerOverlay.classList.add('hidden');

    const countEl = $('channel-count');
    const filterEl = $('filter-channels'); if (filterEl) filterEl.value = '';
    
    const channelIds = state.channelsByCountry.get(code) || [];
    const channels = channelIds.map(id => state.channelsById.get(id)).filter(Boolean);
    
    if (countEl) countEl.textContent = `${channels.length} Live Channels`;
    renderChannelList(channels);
}

function renderChannelList(channels) {
    const ul = $('channels'); if (!ul) return;
    ul.innerHTML = '';
    if (!channels.length) { ul.innerHTML='<li class="empty">📭 No channels with live streams</li>'; return; }
    
    channels.sort((a,b)=>a.name.localeCompare(b.name));
    channels.forEach(ch => {
        const li=document.createElement('li'); li.className='channel-item'; li.dataset.name=ch.name.toLowerCase();
        const logoHtml = ch.logo ? `<img src="${ch.logo}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="logo-placeholder">${ch.name.charAt(0).toUpperCase()}</div>`;
        const cats = ch.categories ? ch.categories.slice(0,2).join(', ') : 'General';
        const sc = ch.streams ? ch.streams.length : 0;
        
        li.innerHTML=`<div class="channel-logo">${logoHtml}</div><div class="channel-info"><div class="channel-name">${escapeHtml(ch.name)}</div><div class="channel-meta">${escapeHtml(cats)}</div><span class="stream-count-badge">▶ ${sc} stream${sc!==1?'s':''}</span></div><button class="play-btn" aria-label="Play ${escapeHtml(ch.name)}">▶</button>`;
        li.querySelector('.play-btn').addEventListener('click', e=>{e.stopPropagation();playChannel(ch);});
        li.addEventListener('click', ()=>playChannel(ch));
        ul.appendChild(li);
    });
}

// ============================================
// PLAYER ERROR HANDLING
// ============================================
function closePlayer() {
    if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance=null; }
    const v=$('video-player'); if(v){v.pause();v.removeAttribute('src');}
    const overlay=$('player-overlay'); if(overlay) overlay.classList.add('hidden');
    state.currentChannel=null;
}

function showPlayerError(show, msg) {
    const loader=$('player-loader'), fallback=$('stream-fallback'), err=$('player-error');
    if(loader) loader.classList.add('hidden');
    if(fallback) fallback.classList.add('hidden');
    if(err) { err.classList.toggle('hidden',!show); if(msg){const p=err.querySelector('p');if(p)p.textContent='⚠️ '+msg;} }
}

// ============================================
// SEARCH
// ============================================
let searchDebounce;
function initSearch() {
    const si=$('search'); if(!si) return;
    si.addEventListener('input', e=>{
        clearTimeout(searchDebounce);
        const q=e.target.value.trim().toLowerCase();
        const results=$('search-results');
        if(!q){if(results)results.classList.add('hidden');return;}
        searchDebounce=setTimeout(()=>performSearch(q),200);
    });
}

function performSearch(query) {
    const results=$('search-results'); if(!results) return;
    const items=[];
    
    state.countryMeta.forEach((c,code)=>{
        if(c.name.toLowerCase().includes(query) && state.channelsByCountry.has(code))
            items.push({type:'country',code,name:c.name,flag:c.flag});
    });
    
    let count=0;
    state.channelsById.forEach(ch=>{
        if(count >12)return;
        if(ch.name.toLowerCase().includes(query)){items.push({type:'channel',channel:ch});count++;}
    });
    
    if(!items.length){results.innerHTML='<div class="search-empty">No results found</div>';}
    else {
        let html='';
        items.forEach(r=>{
            if(r.type==='country') html+=`<div class="search-item" onclick="selectCountry('${r.code}')"><span class="search-flag">${r.flag||'🏳️'}</span><div><div class="search-name">${escapeHtml(r.name)}</div><div class="search-meta">${state.channelsByCountry.get(r.code)?.length||0} channels</div></div></div>`;
            else { const ch=r.channel; const sc=ch.streams?ch.streams.length:0;
                html+=`<div class="search-item" onclick="playChannelById('${ch.id}')"><div class="search-logo">${ch.logo?`<img src="${ch.logo}" onerror="this.style.display='none'">`:ch.name.charAt(0).toUpperCase()}</div><div><div class="search-name">${escapeHtml(ch.name)}</div><div class="search-meta">${ch.country} • ${sc} stream${sc!==1?'s':''}</div></div></div>`;
            }
        });
        results.innerHTML=html;
    }
    results.classList.remove('hidden');
}

window.selectCountry = async code => {
    const feat=state.geoFeatures.find(f=>f.properties.isoA2===code);
    if(feat&&state.globe){const c=getCentroid(feat.geometry);state.globe.pointOfView({lat:c.lat,lng:c.lng,altitude:1.5},1000);}
    await showCountryChannels(code);
    const sr=$('search-results');if(sr)sr.classList.add('hidden');
    const si=$('search');if(si)si.value='';
};

window.playChannelById = id => {
    const ch=state.channelsById.get(id); if(ch)playChannel(ch);
    const sr=$('search-results');if(sr)sr.classList.add('hidden');
    const si=$('search');if(si)si.value='';
};

// ============================================
// NEW FEATURES: VOICE, FAVORITES, DONATIONS
// ============================================
function initNewFeatures() {
    const voiceBtn=$('voice-search-btn');
    if(voiceBtn && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)){
        const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
        const rec=new SR(); rec.continuous=false; rec.interimResults=false; rec.lang='en-US';
        voiceBtn.addEventListener('click',()=>{rec.start();voiceBtn.classList.add('listening');showToast('Listening... ');});
        rec.onresult=(ev)=>{const t=ev.results[0][0].transcript;const si=$('search');if(si){si.value=t;si.dispatchEvent(new Event('input'));}voiceBtn.classList.remove('listening');showToast(`Searching: "${t}"`);};
        rec.onerror=()=>{voiceBtn.classList.remove('listening');showToast('Voice search failed ❌');};
        rec.onend=()=>{voiceBtn.classList.remove('listening');};
    } else if(voiceBtn){voiceBtn.style.display='none';}

    const favToggle=$('favorites-toggle-btn'), favSidebar=$('favorites-sidebar'), closeFav=$('close-favorites');
    if(favToggle && favSidebar){favToggle.addEventListener('click',()=>{favSidebar.classList.remove('hidden');const s=$('sidebar');if(s)s.classList.add('hidden');renderFavorites();});}
    if(closeFav && favSidebar){closeFav.addEventListener('click',()=>favSidebar.classList.add('hidden'));}

    const pfav=$('player-fav-btn');
    if(pfav){pfav.addEventListener('click',()=>{if(state.currentChannel){toggleFavorite(state.currentChannel.id);updatePlayerFavButton();}});}

    const donateBtn=$('donate-btn'), modal=$('donation-modal'), closeDon=$('close-donation');
    if(donateBtn&&modal){donateBtn.addEventListener('click',(e)=>{e.preventDefault();e.stopPropagation();modal.classList.remove('hidden');requestAnimationFrame(()=>modal.classList.add('visible'));});}
    if(closeDon&&modal){closeDon.addEventListener('click',()=>{modal.classList.remove('visible');setTimeout(()=>modal.classList.add('hidden'),300);});}
    if(modal){modal.addEventListener('click',(e)=>{if(e.target===modal){modal.classList.remove('visible');setTimeout(()=>modal.classList.add('hidden'),300);}});}
}

function copyAddress(id){const el=$(id);if(!el)return;navigator.clipboard.writeText(el.innerText).then(()=>showToast('Address copied! 📋')).catch(()=>showToast('Failed to copy ❌'));}

function showToast(msg){const t=$('toast');if(!t)return;t.textContent=msg;t.classList.remove('hidden');t.classList.add('visible');setTimeout(()=>{t.classList.remove('visible');setTimeout(()=>t.classList.add('hidden'),300);},3000);}

function updatePlayerFavButton(){
    const btn=$('player-fav-btn');if(!btn||!state.currentChannel)return;
    const isFav=state.favorites.some(f=>f.id===state.currentChannel.id);
    btn.textContent=isFav?'⭐':'☆';btn.style.color=isFav?'var(--accent-gold)':'var(--text)';btn.style.borderColor=isFav?'var(--accent-gold)':'var(--border)';
}

function renderFavorites(){
    const list=$('favorites-list');if(!list)return;list.innerHTML='';
    if(state.favorites.length===0){list.innerHTML='<li class="empty">No favorites saved yet. Click ⭐ on a channel to save it.</li>';return;}
    state.favorites.forEach(fav=>{
        const ch=state.channelsById.get(fav.id);if(!ch)return;
        const li=document.createElement('li');li.className='favorite-item';
        const lh=ch.logo?`<img src="${ch.logo}" alt="" loading="lazy" onerror="this.style.display='none'">`:`<div class="logo-placeholder">${ch.name.charAt(0).toUpperCase()}</div>`;
        li.innerHTML=`<div class="fav-logo">${lh}</div><div class="fav-info"><div class="fav-name">${escapeHtml(ch.name)}</div><div class="fav-meta">${ch.country}</div></div><button class="remove-fav-btn" title="Remove">🗑️</button>`;
        li.querySelector('.remove-fav-btn').addEventListener('click',(e)=>{e.stopPropagation();toggleFavorite(ch.id);renderFavorites();});
        li.addEventListener('click',()=>playChannel(ch));list.appendChild(li);
    });
}

async function toggleFavorite(channelId){
    const idx=state.favorites.findIndex(f=>f.id===channelId);
    if(idx>-1){
        state.favorites.splice(idx,1);
        await removeFavoriteFromSupabase(channelId);
        showToast('Removed from favorites');
    }
    else{
        state.favorites.push({id:channelId});
        await saveFavoriteToSupabase(channelId);
        showToast('Added to favorites ⭐');
    }
    
    if(state.currentCountry)showCountryChannels(state.currentCountry,true);
}

// ============================================
// GLOBAL EVENT LISTENERS
// ============================================
function initGlobalEvents(){
    const cs=$('close-sidebar');if(cs)cs.addEventListener('click',()=>{const s=$('sidebar');if(s)s.classList.add('hidden');});
    const cp=$('close-player');if(cp)cp.addEventListener('click',closePlayer);
    const ns=$('next-stream');if(ns)ns.addEventListener('click',()=>{if(state.currentChannel)playChannel(state.currentChannel,state.currentStreamIndex+1);});
    const rs=$('retry-stream');if(rs)rs.addEventListener('click',()=>{if(state.currentChannel)playChannel(state.currentChannel,0);});
    const rv=$('reset-view');if(rv)rv.addEventListener('click',()=>{if(state.globe)state.globe.pointOfView({lat:20,lng:0,altitude:2.5},1500);});
    const fi=$('filter-channels');if(fi)fi.addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('.channel-item').forEach(li=>{li.style.display=li.dataset.name.includes(q)?'':'none';});});
    
    document.addEventListener('click',e=>{if(!e.target.closest('.search-box')){const sr=$('search-results');if(sr)sr.classList.add('hidden');}});
    
    document.addEventListener('keydown',e=>{
        if(e.key==='Escape'){
            closePlayer();
            const s=$('sidebar');if(s)s.classList.add('hidden');
            const fs=$('favorites-sidebar');if(fs)fs.classList.add('hidden');
            const sr=$('search-results');if(sr)sr.classList.add('hidden');
            const m=$('donation-modal');if(m){m.classList.remove('visible');setTimeout(()=>m.classList.add('hidden'),300);}
        }
    });
}

// ============================================
// HELPERS
// ============================================
function escapeHtml(text){const d=document.createElement('div');d.textContent=text;return d.innerHTML;}
function setLoadingProgress(pct,msg){const bar=$('loading-bar');if(bar)bar.style.width=pct+'%';const txt=$('loading-text');if(msg&&txt)txt.textContent=msg;}
function hideLoading(){const o=$('loading-overlay');if(o){o.style.opacity='0';setTimeout(()=>o.classList.add('hidden'),500);}}

// ============================================
// MAIN INIT — WITH GLOBAL SAFETY NET
// ============================================
async function init() {
    try {
        initParticles();
        initTracking();
        setLoadingProgress(5,'Initializing Grid...');
        initGlobe();
        initSearch();
        initNewFeatures();
        initGlobalEvents();
        
        // Load favorites from Supabase before showing UI
        setLoadingProgress(10,'Syncing Favorites...');
        state.favorites = await loadFavoritesFromSupabase();
        
        setLoadingProgress(15,'Loading channels...');
        const [chRes,coRes,geoRes] = await Promise.all([
            fetchWithCache('https://iptv-org.github.io/api/channels.json','channels_v2'),
            fetchWithCache('https://iptv-org.github.io/api/countries.json','countries_v2'),
            fetch('https://raw.githubusercontent.com/vasturiano/globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson')
        ]);
        
        setLoadingProgress(45,'Processing channel data...');
        processData(await chRes.json(), await coRes.json(), await geoRes.json());
        
        setLoadingProgress(65,'Fetching public stream data...');
        await loadAllStreams();
        filterChannelsWithNoStreams();
        tagOpenViewChannels();
        rebuildCountryCounts();
        
        state.dataLoaded = true;
        updateStats();
        
        setLoadingProgress(100,'Ready!');
        setTimeout(hideLoading, 400);
        prefetchLogos();
        
    } catch (err) {
        console.error('Critical init error:', err);
        const lt=$('loading-text');
        if(lt) lt.textContent='Error Loading — Retrying...';
        setTimeout(init, 5000);
    }
}

if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}
else{init();}