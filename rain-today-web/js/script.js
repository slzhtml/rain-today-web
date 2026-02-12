// @ts-nocheck
// === Toggle panneau (doit être en haut pour marcher même si le reste plante) ===
document.addEventListener("DOMContentLoaded", () => {
  const panel = document.getElementById("bottomPanel");
  const btn = document.getElementById("togglePanelBtn");
  if (!panel || !btn) return;

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const collapsed = panel.classList.toggle("collapsed");
    btn.textContent = collapsed ? "⬆ Ouvrir" : "⬇ Réduire";
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  });
});

/* ============
   NOTES
   - Search uses Nominatim (OSM) geocoding.
   - Radar is RainViewer tiles (native zoom limited); we keep zoom free by upscaling with maxNativeZoom.
   - Wind particles are subtle (canvas opacity set in CSS) so radar stays visible.
   - "Direction pluie" is a visual helper: arrows use wind direction as proxy for rain movement.
============ */

let map;
let baseOSM, baseSat;
let userMarker = null;

let radarLayer = null;
let frames = [];
let frameIndex = 0;
let anim = null;

let windCanvas, windCtx;
let windRunning = false;
let windParticles = [];
let windCenter = { spd: 0, deg: 0, u: 0, v: 0 };

let windArrowLayer = null;
let rainDirLayer = null;

const statusEl = document.getElementById("status");
const sliderEl = document.getElementById("timeline");
const playBtnEl = document.getElementById("playBtn");
const timeLabelEl = document.getElementById("timeLabel");

const radarToggle = document.getElementById("radarToggle");
const rainAutoToggle = document.getElementById("rainAutoToggle");
const rainDirToggle = document.getElementById("rainDirToggle");
const windParticlesToggle = document.getElementById("windParticlesToggle");
const windArrowsToggle = document.getElementById("windArrowsToggle");
const themeBtn = document.getElementById("themeBtn");

const citySearch = document.getElementById("citySearch");
const searchResults = document.getElementById("searchResults");

const addFavBtn = document.getElementById("addFavBtn");
const favList = document.getElementById("favList");

const toastHost = document.getElementById("toastHost");

const bmOsm = document.getElementById("bmOsm");
const bmSat = document.getElementById("bmSat");

const FAV_KEY = "rt_favs_v2";
const ALERT_KEY = "rt_alerts_v2";

async function getCityName(lat, lon) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`
    );

    const data = await res.json();

    if (!data.address) return null;

    return (
      data.address.city ||
      data.address.town ||
      data.address.village ||
      data.address.municipality ||
      data.address.county ||
      null
    );
  } catch (err) {
    console.warn("Reverse geocoding error:", err);
    return null;
  }
}

/* ============
   THEME (smart night mode)
============ */
@@ -368,6 +392,9 @@
async function onMapClick(latlng){
  const { lat, lng } = latlng;

  // ✅ NOUVEAU : ville depuis coordonnées (OSM / Nominatim)
  const city = await getCityName(lat, lng);

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lng}` +
@@ -400,9 +427,13 @@

    const stormRisk = thunderRiskFromWeatherCode(wcode);

    const placeLine = city
      ? `📍 <b>${escapeHtml(city)}</b> — ${lat.toFixed(3)}, ${lng.toFixed(3)}`
      : `📍 ${lat.toFixed(3)}, ${lng.toFixed(3)}`;

    const html = `
      <div style="min-width:270px">
        <div style="font-weight:900;margin-bottom:6px">📍 ${lat.toFixed(3)}, ${lng.toFixed(3)}</div>
        <div style="font-weight:900;margin-bottom:6px">${placeLine}</div>

        <div>🌡️ Temp: <b>${fmt(temp)}°C</b> — Ressenti: <b>${fmt(feel)}°C</b></div>

@@ -433,555 +464,556 @@
  }
}


/* ============
   WIND: center + particles + arrows
============ */
async function refreshCenterWind(){
  if (!map) return;
  const c = map.getCenter();
  const w = await fetchPointWind(c.lat, c.lng);
  if (w) windCenter = w;
}

async function fetchPointWind(lat, lon){
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=windspeed_10m,winddirection_10m&timezone=auto`;

  try{
    const res = await fetch(url);
    const data = await res.json();

    const spd = data.hourly.windspeed_10m[0];
    const deg = data.hourly.winddirection_10m[0];

    // Convert FROM to flow TO (deg+180)
    const toDeg = (deg + 180) % 360;
    const toRad = (toDeg * Math.PI) / 180;

    const u = Math.sin(toRad) * spd;
    const v = Math.cos(toRad) * spd;

    return { spd, deg, u, v };
  }catch(err){
    console.error(err);
    return null;
  }
}

/* Wind particles (subtle) */
function startWindParticles(){
  windRunning = true;
  initParticles();
  loopParticles();
}
function stopWindParticles(){
  windRunning = false;
  windParticles = [];
  clearCanvas();
}
function clearCanvas(){
  windCtx.clearRect(0,0,window.innerWidth,window.innerHeight);
}
function initParticles(){
  windParticles = [];
  const count = 650;
  for (let i=0;i<count;i++) windParticles.push(newParticle());
}
function newParticle(){
  return { x: Math.random()*window.innerWidth, y: Math.random()*window.innerHeight, age: Math.random()*120 };
}
function loopParticles(){
  if (!windRunning) return;

  // Very light trails so radar stays readable
  windCtx.fillStyle = document.body.classList.contains("dark")
    ? "rgba(0,0,0,0.10)"
    : "rgba(255,255,255,0.10)";
  windCtx.fillRect(0,0,window.innerWidth,window.innerHeight);

  windCtx.lineWidth = 1;
  windCtx.strokeStyle = windColor(windCenter.spd);

  const spd = windCenter.spd || 0;
  const speedFactor = clamp(spd/25, 0.2, 2.6);

  for (const p of windParticles){
    const x0 = p.x, y0 = p.y;

    p.x += (windCenter.u * 0.07) * speedFactor;
    p.y += (windCenter.v * -0.07) * speedFactor;

    p.age++;

    windCtx.beginPath();
    windCtx.moveTo(x0,y0);
    windCtx.lineTo(p.x,p.y);
    windCtx.stroke();

    if (p.x<0 || p.x>window.innerWidth || p.y<0 || p.y>window.innerHeight || p.age>150){
      Object.assign(p, newParticle());
    }
  }

  requestAnimationFrame(loopParticles);
}

/* Wind arrows */
async function drawWindArrows(){
  if (!map) return;
  clearWindArrows();

  const b = map.getBounds();
  const nx=9, ny=6;

  const pts = [];
  for (let y=0; y<ny; y++){
    for (let x=0; x<nx; x++){
      const lat = b.getSouth() + (b.getNorth()-b.getSouth())*(y/(ny-1));
      const lon = b.getWest()  + (b.getEast()-b.getWest())*(x/(nx-1));
      pts.push({lat,lon});
    }
  }

  windArrowLayer = L.layerGroup([], {pane:"windArrowPane"}).addTo(map);

  const batchSize=8;
  for (let i=0; i<pts.length; i+=batchSize){
    const batch = pts.slice(i,i+batchSize);
    const res = await Promise.all(batch.map(p => fetchPointWind(p.lat,p.lon).catch(()=>null)));

    res.forEach((w, idx) => {
      if (!w) w = windCenter;
      const icon = arrowIcon(w.spd, w.deg, "wind");
      L.marker([batch[idx].lat, batch[idx].lon], { icon, interactive:false, pane:"windArrowPane" }).addTo(windArrowLayer);
    });
  }
}
function clearWindArrows(){
  if (windArrowLayer){
    map.removeLayer(windArrowLayer);
    windArrowLayer=null;
  }
}

/* ============
   RAIN DIRECTION (proxy from wind)
============ */
function drawRainDirection(){
  if (!map) return;
  clearRainDirection();

  const b = map.getBounds();
  const nx=7, ny=5;

  const pts = [];
  for (let y=0; y<ny; y++){
    for (let x=0; x<nx; x++){
      const lat = b.getSouth() + (b.getNorth()-b.getSouth())*(y/(ny-1));
      const lon = b.getWest()  + (b.getEast()-b.getWest())*(x/(nx-1));
      pts.push({lat,lon});
    }
  }

  rainDirLayer = L.layerGroup([], {pane:"rainDirPane"}).addTo(map);

  pts.forEach(p => {
    // Use center wind as a simple "movement" indicator for rain direction
    const icon = arrowIcon(Math.max(10, windCenter.spd), windCenter.deg, "rain");
    L.marker([p.lat, p.lon], { icon, interactive:false, pane:"rainDirPane" }).addTo(rainDirLayer);
  });
}
function clearRainDirection(){
  if (rainDirLayer){
    map.removeLayer(rainDirLayer);
    rainDirLayer=null;
  }
}

/* ============
   ICONS
============ */
function arrowIcon(spd, degFrom, kind){
  const degTo = (degFrom + 180) % 360; // flow direction
  const size = 20;
  const color = kind === "rain" ? "rgba(77,166,255,0.95)" : windColor(spd);
  const html = `
    <div style="
      width:${size}px;height:${size}px;
      transform: rotate(${degTo}deg);
      color:${color};
      font-size:${size}px;
      line-height:${size}px;
      text-shadow:0 1px 2px rgba(0,0,0,.35);
    ">➤</div>`;
  return L.divIcon({ className:"", html, iconSize:[size,size], iconAnchor:[size/2,size/2] });
}

/* ============
   SEARCH (Nominatim)
============ */
function initSearchUI(){
  let t = null;

  citySearch.addEventListener("input", () => {
    const q = citySearch.value.trim();
    if (t) clearTimeout(t);

    if (!q || q.length < 3){
      hideResults();
      return;
    }
    t = setTimeout(() => searchCity(q), 250);
  });

  document.addEventListener("click", (e) => {
    if (!searchResults.contains(e.target) && e.target !== citySearch){
      hideResults();
    }
  });
}

async function searchCity(q){
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=8&q=${encodeURIComponent(q)}`;
  try{
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    const items = await res.json();
    renderResults(items);
  }catch(err){
    console.error(err);
    hideResults();
  }
}

function renderResults(items){
  searchResults.innerHTML = "";
  if (!items || !items.length){
    hideResults();
    return;
  }
  items.forEach(it => {
    const div = document.createElement("div");
    div.className = "search-item";
    div.textContent = it.display_name;
    div.addEventListener("click", () => {
      const lat = parseFloat(it.lat);
      const lon = parseFloat(it.lon);
      goToLocation(lat, lon, it.display_name);
      hideResults();
    });
    searchResults.appendChild(div);
  });
  searchResults.classList.remove("hidden");
}
function hideResults(){ searchResults.classList.add("hidden"); }

/* ============
   FAVORITES (max 5)
============ */
addFavBtn.addEventListener("click", () => {
  const c = map.getCenter();
  const name = (citySearch.value && citySearch.value.trim().length >= 3)
    ? citySearch.value.trim()
    : `Favori ${new Date().toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})}`;

  addFavorite({ name, lat: c.lat, lon: c.lng });
});

function getFavs(){
  try{ return JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); }catch{ return []; }
}
function setFavs(favs){
  localStorage.setItem(FAV_KEY, JSON.stringify(favs));
}

function addFavorite(f){
  let favs = getFavs();
  favs = favs.filter(x => distKm(x.lat,x.lon,f.lat,f.lon) > 0.3);
  favs.unshift(f);
  favs = favs.slice(0,5);
  setFavs(favs);
  renderFavs();

  pushToast({
    icon: "⭐",
    title: "Ajouté aux favoris",
    message: f.name,
    time: "À l’instant",
    actionText: "Voir",
    onAction: () => goToLocation(f.lat, f.lon, f.name)
  });
}

function removeFavorite(lat, lon){
  let favs = getFavs();
  favs = favs.filter(x => distKm(x.lat,x.lon,lat,lon) > 0.001);
  setFavs(favs);
  renderFavs();
}

function renderFavs(){
  const favs = getFavs();
  favList.innerHTML = "";

  favs.forEach(f => {
    const chip = document.createElement("div");
    chip.className = "fav-chip";
    chip.innerHTML = `<span>${escapeHtml(shortName(f.name))}</span><small>${f.lat.toFixed(2)}, ${f.lon.toFixed(2)}</small><span class="x">✕</span>`;

    chip.addEventListener("click", (e) => {
      const isX = e.target && e.target.classList && e.target.classList.contains("x");
      if (isX){
        removeFavorite(f.lat, f.lon);
        e.stopPropagation();
        return;
      }
      goToLocation(f.lat, f.lon, f.name);
    });

    favList.appendChild(chip);
  });
}

/* ============
   NAVIGATION
============ */
async function goToLocation(lat, lon, label){
  map.setView([lat, lon], Math.max(map.getZoom(), 8), { animate: true });

  if (userMarker) userMarker.setLatLng([lat, lon]);
  citySearch.value = label || "";

  await refreshCenterWind();
  if (rainDirToggle.checked) drawRainDirection();
  if (windArrowsToggle.checked) drawWindArrows();

  pushToast({
    icon: "📍",
    title: "Position mise à jour",
    message: label ? label : `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
    time: "À l’instant",
    actionText: "Météo",
    onAction: () => onMapClick({lat, lng: lon})
  });
}

/* ============
   IN-SITE ALERTS (toasts)
============ */
function startAlertLoop(){
  checkAlerts().catch(()=>{});
  setInterval(() => checkAlerts().catch(()=>{}), 180000);
}
function getAlertState(){
  try{ return JSON.parse(localStorage.getItem(ALERT_KEY) || "{}"); }catch{ return {}; }
}
function setAlertState(st){
  localStorage.setItem(ALERT_KEY, JSON.stringify(st));
}

async function checkAlerts(){
  if (!map) return;

  const c = map.getCenter();
  const lat = c.lat, lon = c.lng;

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&minutely_15=precipitation` +
    `&hourly=windspeed_10m` +
    `&timezone=auto`;

  const res = await fetch(url);
  const data = await res.json();

  const st = getAlertState();
  const now = Date.now();

  // Rain soon
  const rain15 = data.minutely_15 && data.minutely_15.precipitation ? data.minutely_15.precipitation : [];
  const ev = computeRainEvent15(rain15);
  if (ev.startMin !== null && ev.startMin <= 90){
    const key = `rain_${Math.round(lat*100)}_${Math.round(lon*100)}_${ev.startMin}`;
    const last = st[key] || 0;
    if (now - last > 20*60*1000){
      st[key] = now;
      setAlertState(st);

      pushToast({
        icon: "🌧️",
        title: `Pluie dans ~${ev.startMin} min`,
        message: `Durée ~${ev.durationMin} min • Cumul ~${fmt(ev.totalMm)} mm`,
        time: "Mise à jour",
        actionText: "Voir",
        onAction: () => map.setView([lat, lon], Math.max(map.getZoom(), 9), { animate: true })
      });
    }
  }

  // Wind peak soon
  const windH = data.hourly && data.hourly.windspeed_10m ? data.hourly.windspeed_10m : [];
  const windPeak = findWindPeakSoon(windH);
  if (windPeak && windPeak.minutes <= 180 && windPeak.kmh >= 60){
    const key = `wind_${Math.round(lat*100)}_${Math.round(lon*100)}_${windPeak.minutes}_${Math.round(windPeak.kmh)}`;
    const last = st[key] || 0;
    if (now - last > 30*60*1000){
      st[key] = now;
      setAlertState(st);

      pushToast({
        icon: "🌬️",
        title: `Vent fort dans ~${windPeak.minutes} min`,
        message: `Pic ~${Math.round(windPeak.kmh)} km/h`,
        time: "Mise à jour",
        actionText: "Voir",
        onAction: () => map.setView([lat, lon], Math.max(map.getZoom(), 9), { animate: true })
      });
    }
  }
}

function findWindPeakSoon(arr){
  if (!arr || !arr.length) return null;
  let best = { i: 0, kmh: arr[0] };
  for (let i=0; i<Math.min(arr.length, 6); i++){
    if (arr[i] > best.kmh) best = { i, kmh: arr[i] };
  }
  return { minutes: best.i * 60, kmh: best.kmh };
}

/* ============
   TOASTS
============ */
function pushToast({icon, title, message, time, actionText, onAction}){
  const toast = document.createElement("div");
  toast.className = "toast";

  toast.innerHTML = `
    <div class="icon">${escapeHtml(icon || "ℹ️")}</div>
    <div>
      <div class="title">${escapeHtml(title || "")}</div>
      <div class="meta">${escapeHtml(message || "")}</div>
      <div class="meta" style="margin-top:4px">${escapeHtml(time || "")}</div>
    </div>
    <div class="toast-row">
      ${actionText ? `<button class="action">${escapeHtml(actionText)}</button>` : ""}
      <button class="close" title="Fermer">✕</button>
    </div>
  `;

  const btn = toast.querySelector(".action");
  const close = toast.querySelector(".close");

  function dismiss(){
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-6px)";
    setTimeout(() => toast.remove(), 180);
  }

  if (btn && onAction){
    btn.addEventListener("click", () => { try{ onAction(); }catch{} dismiss(); });
  }
  close.addEventListener("click", dismiss);

  toastHost.appendChild(toast);
  setTimeout(() => { if (toast.isConnected) dismiss(); }, 8000);
}

/* ============
   HELPERS
============ */
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function fmt(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return (Math.round(x * 10) / 10).toString();
}
function degToCardinal(deg){
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  const i = Math.round(((deg % 360) / 22.5)) % 16;
  return dirs[i];
}
function windFromText(deg){ return degToCardinal(deg); }

function rainCategory(mmPerH){
  if (mmPerH <= 0.2) return "faible";
  if (mmPerH <= 2) return "modérée";
  if (mmPerH <= 10) return "forte";
  return "très forte";
}
function windCategory(kmh){
  if (kmh <= 15) return "calme";
  if (kmh <= 35) return "modéré";
  if (kmh <= 60) return "fort";
  return "très fort";
}
function snowCategory(cmPerH){
  if (cmPerH <= 0.2) return "faible";
  if (cmPerH <= 1) return "modérée";
  if (cmPerH <= 3) return "forte";
  return "très forte";
}
function thunderRiskFromWeatherCode(code){
  // 95/96/99 thunderstorms, else none. Show as low/medium/high to match legend
  if (code === 95) return "moyen";
  if (code === 96 || code === 99) return "élevé";
  return "faible";
}
function windColor(kmh){
  if (kmh <= 15) return "rgba(102,204,255,0.95)";
  if (kmh <= 35) return "rgba(51,204,102,0.95)";
  if (kmh <= 60) return "rgba(255,153,0,0.95)";
  return "rgba(153,0,255,0.95)";
}
function computeRainEvent15(arr){
  const TH = 0.1;
  if (!arr || !arr.length) return { startMin: null, durationMin: 0, totalMm: 0 };

  let start = null;
  for (let i=0; i<arr.length; i++){
    if (arr[i] > TH){ start = i; break; }
  }
  if (start === null) return { startMin: null, durationMin: 0, totalMm: 0 };

  let total = 0;
  let end = start;
  for (let i=start; i<arr.length; i++){
    if (arr[i] > TH){
      total += arr[i];
      end = i;
    } else break;
  }

  return { startMin: start * 15, durationMin: (end-start+1)*15, totalMm: total };
}
function distKm(lat1,lon1,lat2,lon2){
  const R=6371;
  const dLat=(lat2-lat1)*Math.PI/180;
  const dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function shortName(s){
  const t = (s||"").split(",")[0];
  return t.length > 22 ? t.slice(0,22)+"…" : t;
}
function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

/* ============
   START
============ */
navigator.geolocation.getCurrentPosition(
  (pos) => initMap(pos.coords.latitude, pos.coords.longitude),
  () => initMap(48.8566, 2.3522),
  { enableHighAccuracy: true, timeout: 10000 }
);

~
