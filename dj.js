/* =========================================================================
   VVYNAS VANE — DJ MODE
   Dual-deck Web Audio engine + a 1:1 canvas port of DJVisualizer.java's
   layered rings / lasers / grid / waveform bars / particles.
   ========================================================================= */
(() => {
"use strict";
const { idbGet, idbSet, idbDelete, idbGetAllKeys, fsApiSupported, verifyPermission, pickDirectory, getStoredHandle, walkDirectory, generatedArt, AUDIO_EXT, C, linGrad, radGrad } = window.VV;

/** Same art priority as the main library: a custom uploaded photo, then
 *  the song's own embedded cover (cached in IndexedDB the first time the
 *  main library scanned it — see loadEmbeddedArt in app.js), then the
 *  generated placeholder. DJ Mode doesn't re-scan files for embedded art
 *  itself; it just reuses whatever the main app already found. */
async function deckArtUrl(song) {
  try {
    const custom = await idbGet("customArt", song.id);
    if (custom) return custom;
    const embedded = await idbGet("embeddedArt", song.id);
    if (embedded) return embedded;
  } catch { /* fall back below */ }
  return generatedArt(song.title + song.artist + song.id, 120);
}

function titleCaseFromFilename(name) {
  const noExt = name.replace(AUDIO_EXT, "");
  const cleaned = noExt.replace(/[_]+/g, " ").trim();
  const m = cleaned.match(/^(.{1,60}?)\s*-\s*(.{1,80})$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: "", title: cleaned };
}

/* ---------------------------------------------------------------------
   DJVisualizer — ported from views/DJVisualizer.java
   4 themes: DRAGONFIRE, LANNISTER, STARK WINTER, NIGHT KING
   (source names: NEON ALIEN, INFERNO, ARCTIC, CYBER MATRIX)
   --------------------------------------------------------------------- */
const THEMES = [
  { name: "DRAGONFIRE", pal: [0xFF020408, 0xFF00FFD4, 0xFF7B2FFF, 0xFFFF2D78] },
  { name: "LANNISTER",  pal: [0xFF100200, 0xFFFF6B00, 0xFFFF2D00, 0xFFFFE500] },
  { name: "STARK WINTER", pal: [0xFF00080F, 0xFF00A8FF, 0xFF00FFD4, 0xFFFFFFFF] },
  { name: "NIGHT KING", pal: [0xFF001200, 0xFF39FF14, 0xFF00FF88, 0xFF7B2FFF] },
];

const Visualizer = (() => {
  let canvas, ctx, W = 0, H = 0, raf = null, lastFrame = 0, globalTime = 0;
  let energy = 0, beatPulse = 0, theme = 0, initialized = false;

  const PARTICLE_COUNT = 40, RING_COUNT = 5, BAR_COUNT = 48, LASER_COUNT = 6;
  // Global intensity dial — keeps the visualizer feeling alive as a full-page
  // backdrop without ever fighting the glass cards for attention.
  const INTENSITY = 0.55;
  let px = [], py = [], pvx = [], pvy = [], pSize = [], pAlpha = [], pColor = [];
  let ringR = [], ringA = [], ringSpeed = [];
  let barH = [], barTarget = [];
  let laserAngle = [], laserSpeed = [], laserAlpha = [];

  function rand() { return Math.random(); }

  function respawnParticle(i, anywhere) {
    const pal = THEMES[theme].pal;
    px[i] = anywhere ? rand() * W : (rand() < .5 ? -10 : W + 10);
    py[i] = anywhere ? rand() * H : H + 10;
    const speed = .5 + rand() * 2;
    pvx[i] = (rand() - .5) * speed;
    pvy[i] = -.5 - rand() * speed;
    pSize[i] = 2 + rand() * 5;
    pAlpha[i] = (.4 + rand() * .6) * INTENSITY;
    const colors = [pal[1], pal[2], pal[3]];
    pColor[i] = colors[Math.floor(rand() * 3)];
  }

  function setupScene() {
    px = []; py = []; pvx = []; pvy = []; pSize = []; pAlpha = []; pColor = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) { px.push(0); py.push(0); pvx.push(0); pvy.push(0); pSize.push(0); pAlpha.push(0); pColor.push(0); respawnParticle(i, true); }
    ringR = []; ringA = []; ringSpeed = [];
    for (let i = 0; i < RING_COUNT; i++) { ringR.push((i + 1) * (Math.min(W, H) * .15)); ringA.push(.3 + i * .1); ringSpeed.push(.3 + i * .15); }
    barH = []; barTarget = [];
    for (let i = 0; i < BAR_COUNT; i++) { const v = rand() * H * .15; barH.push(v); barTarget.push(v); }
    laserAngle = []; laserSpeed = []; laserAlpha = [];
    for (let i = 0; i < LASER_COUNT; i++) {
      laserAngle.push(i * Math.PI * 2 / LASER_COUNT);
      laserSpeed.push((.005 + i * .002) * (i % 2 === 0 ? 1 : -1));
      laserAlpha.push(.25 + rand() * .3);
    }
    initialized = true;
  }

  function drawGrid(pal) {
    ctx.strokeStyle = C(pal[1], (18 / 255) * INTENSITY); ctx.lineWidth = .5;
    const cols = 12, rows = 20, cw = W / cols, rh = H / rows;
    const yOff = (globalTime * 30) % rh;
    for (let r = 0; r <= rows + 1; r++) { ctx.beginPath(); ctx.moveTo(0, r * rh - yOff); ctx.lineTo(W, r * rh - yOff); ctx.stroke(); }
    for (let c = 0; c <= cols; c++) { ctx.beginPath(); ctx.moveTo(c * cw, 0); ctx.lineTo(c * cw, H); ctx.stroke(); }
  }
  function drawLasers(pal) {
    const cx = W / 2, cy = H * .4;
    for (let i = 0; i < LASER_COUNT; i++) {
      laserAngle[i] += laserSpeed[i] * (1 + energy * 3);
      const endX = cx + Math.cos(laserAngle[i]) * W, endY = cy + Math.sin(laserAngle[i]) * H;
      const lc = i % 3 === 0 ? pal[1] : i % 3 === 1 ? pal[2] : pal[3];
      const a = laserAlpha[i] * (.5 + energy * .5) * INTENSITY;
      ctx.strokeStyle = linGrad(ctx, cx, cy, endX, endY, [C(lc, a), C(lc, 0)]);
      ctx.lineWidth = (1 + energy * 2 + beatPulse * 3) * INTENSITY;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(endX, endY); ctx.stroke();
    }
  }
  function drawRings(pal) {
    const cx = W / 2, cy = H * .38, maxR = Math.min(W, H) * (.5 + energy * .3 + beatPulse * .2);
    for (let i = 0; i < RING_COUNT; i++) {
      ringR[i] += ringSpeed[i] * (1 + energy * 4);
      if (ringR[i] > maxR) { ringR[i] = 10; ringA[i] = .8 * INTENSITY; }
      const t = ringR[i] / maxR; ringA[i] = Math.max(0, (1 - t) * .7 * INTENSITY);
      const rc = i % 3 === 0 ? pal[1] : i % 3 === 1 ? pal[2] : pal[3];
      ctx.strokeStyle = C(rc, ringA[i]); ctx.lineWidth = 1.5 + energy * 3;
      ctx.beginPath(); ctx.arc(cx, cy, ringR[i], 0, Math.PI * 2); ctx.stroke();
    }
  }
  function drawBars(pal) {
    const barW = W / BAR_COUNT, baseY = H * .75, maxBarH = H * .25;
    for (let i = 0; i < BAR_COUNT; i++) {
      if (rand() < .12) barTarget[i] = Math.min((.05 + rand() * .95) * maxBarH * (.2 + energy * .8 + beatPulse * .5), maxBarH);
      barH[i] += (barTarget[i] - barH[i]) * .25;
    }
    for (let i = 0; i < BAR_COUNT; i++) {
      const bh = barH[i], x0 = i * barW, x1 = x0 + barW - 1;
      const topC = i % 3 === 0 ? pal[1] : i % 3 === 1 ? pal[2] : pal[3];
      ctx.fillStyle = linGrad(ctx, 0, baseY - bh, 0, baseY, [C(topC, 220 / 255), C(topC, 40 / 255)]);
      ctx.fillRect(x0, baseY - bh, x1 - x0, bh);
      ctx.fillStyle = linGrad(ctx, 0, baseY, 0, baseY + bh * .4, [C(topC, 80 / 255), C(topC, 0)]);
      ctx.fillRect(x0, baseY, x1 - x0, bh * .4);
    }
  }
  function drawParticles() {
    const speed = 1 + energy * 3 + beatPulse * 2;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      px[i] += pvx[i] * speed; py[i] += pvy[i] * speed; pAlpha[i] -= .003;
      if (py[i] < -20 || px[i] < -20 || px[i] > W + 20 || pAlpha[i] <= 0) respawnParticle(i, false);
      ctx.fillStyle = C(pColor[i], Math.max(0, pAlpha[i]));
      const s = pSize[i] * (1 + energy * .5 + beatPulse * .5);
      ctx.beginPath(); ctx.arc(px[i], py[i], s, 0, Math.PI * 2); ctx.fill();
    }
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (!ctx || W <= 0 || H <= 0) return;
    if (!initialized) setupScene();
    const dt = lastFrame === 0 ? 16 : Math.min(t - lastFrame, 50);
    lastFrame = t; globalTime += dt * .001;
    const pal = THEMES[theme].pal;
    beatPulse = Math.max(0, beatPulse - dt * .004);

    ctx.fillStyle = C(pal[0], 1); ctx.fillRect(0, 0, W, H);
    const glowR = Math.min(W, H) * (.3 + energy * .4 + beatPulse * .3);
    ctx.fillStyle = radGrad(ctx, W / 2, H / 2, glowR, [C(pal[1], Math.min(1, (80 + energy * 120 + beatPulse * 80) / 255)), C(pal[1], 0)]);
    ctx.fillRect(0, 0, W, H);

    drawGrid(pal); drawLasers(pal); drawRings(pal); drawBars(pal); drawParticles();

    if (beatPulse > .05) { ctx.fillStyle = C(pal[1], beatPulse * 40 / 255); ctx.fillRect(0, 0, W, H); }
  }

  function resize() { if (!canvas) return; W = canvas.width = canvas.clientWidth; H = canvas.height = canvas.clientHeight; initialized = false; }
  function init(canvasEl) { canvas = canvasEl; ctx = canvas.getContext("2d"); resize(); window.addEventListener("resize", resize); if (!raf) requestAnimationFrame(frame); }
  function setEnergy(e) { energy = Math.max(0, Math.min(1, e)); }
  function triggerBeat() { beatPulse = 1; }
  function setTheme(t) { theme = ((t % THEMES.length) + THEMES.length) % THEMES.length; initialized = false; }
  function getTheme() { return theme; }

  return { init, setEnergy, triggerBeat, setTheme, getTheme };
})();

/* ---------------------------------------------------------------------
   State
   --------------------------------------------------------------------- */
const state = {
  allSongs: [], fileRefs: new Map(), usingFSApi: false,
  deckA: { song: null, audio: null, prepared: false, playing: false, source: null, filter: null, gain: null, objectUrl: null },
  deckB: { song: null, audio: null, prepared: false, playing: false, source: null, filter: null, gain: null, objectUrl: null },
  crossfadePos: .5, bassLevel: 50, autoMixActive: false, beatSyncActive: false,
  djQueue: [], pickerTarget: null, // "A" | "B" | "queue"
  crossfadeDurationS: 6,
};

let audioCtx = null, masterGain = null;
function ensureAudioContext() {
  if (audioCtx) return audioCtx;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1;
  masterGain.connect(audioCtx.destination);
  return audioCtx;
}

const $ = (s) => document.querySelector(s);
const els = {
  grant: $("#djGrant"), grantBtn: $("#djGrantBtn"), app: $("#djApp"), status: $("#djStatus"),
  visualBtn: $("#djVisualBtn"), settingsBtn: $("#djSettingsBtn"),
  deckAArt: $("#deckAArt"), deckATitle: $("#deckATitle"), deckAArtist: $("#deckAArtist"), deckACount: $("#deckACount"),
  deckAPitch: $("#deckAPitch"), deckASelect: $("#deckASelect"), deckAPlay: $("#deckAPlay"), deckACue: $("#deckACue"),
  deckBArt: $("#deckBArt"), deckBTitle: $("#deckBTitle"), deckBArtist: $("#deckBArtist"), deckBCount: $("#deckBCount"),
  deckBPitch: $("#deckBPitch"), deckBSelect: $("#deckBSelect"), deckBPlay: $("#deckBPlay"), deckBCue: $("#deckBCue"),
  crossfader: $("#crossfader"), bassSlider: $("#bassSlider"), bassLabel: $("#bassLabel"),
  btnAutoMix: $("#btnAutoMix"), btnBeatSync: $("#btnBeatSync"), btnShoutout: $("#btnShoutout"),
  addQueueBtn: $("#djAddQueueBtn"), queueList: $("#queueList"),
  shoutoutText: $("#shoutoutText"), toast: $("#toast"),
  pickerOverlay: $("#pickerOverlay"), pickerTitle: $("#pickerTitle"), pickerSearch: $("#pickerSearch"), pickerList: $("#pickerList"), pickerCloseBtn: $("#pickerCloseBtn"),
  settingsOverlay: $("#djSettingsOverlay"), settingsCloseBtn: $("#djSettingsCloseBtn"),
  optVisualTheme: $("#optVisualTheme"), visualThemeName: $("#visualThemeName"), optCrossfade: $("#optCrossfade"), crossfadeDurLabel: $("#crossfadeDurLabel"),
  optBassPreset: $("#optBassPreset"), optResetCounts: $("#optResetCounts"), optClearQueue: $("#optClearQueue"), optAbout: $("#optAbout"),
  aboutOverlay: $("#aboutOverlay"), aboutCloseBtn: $("#aboutCloseBtn"),
};

function toast(msg) { els.toast.textContent = msg; els.toast.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => els.toast.classList.remove("show"), 2200); }
function escapeHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function setStatus(msg) { els.status.textContent = msg; }

/* ---------------------------------------------------------------------
   Shoutouts
   --------------------------------------------------------------------- */
const SHOUTOUT_PHRASES = [
  "⚔ THE REALM ERUPTS!!", "🐉 A DRAGON GRACES THE HALL!!", "⚔ THE HOUR OF THE WOLF!!",
  "🦁 HEAR ME ROAR — LANNISTER ANTHEM!!", "❄ WINTER IS HERE — THE ANTHEM!!", "🐺 THE DIREWOLF HOWLS AGAIN!!",
  "🔥 DRACARYS — FEEL THE FIRE!!", "⚔ THE IRON THRONE TRACK!!", "👑 ALL MEN MUST HEAR THIS!!", "🌙 THE RED WOMAN FORETOLD THIS!!",
];
let shoutoutTimer = null;
function showShoutout(msg, durationMs) {
  clearTimeout(shoutoutTimer);
  els.shoutoutText.textContent = msg;
  els.shoutoutText.classList.add("show");
  shoutoutTimer = setTimeout(() => els.shoutoutText.classList.remove("show"), durationMs);
}
async function incrementAndCheckShoutout(song, isDeckA) {
  if (!song) return;
  const key = song.id;
  const count = ((await idbGet("djPlayCounts", key)) || 0) + 1;
  await idbSet("djPlayCounts", key, count);
  updatePlayCountBadge(song, isDeckA ? els.deckACount : els.deckBCount, count);
  let msg = null;
  if (count === 3) msg = `🔥 ${song.title.toUpperCase()} — 3 PLAYS TONIGHT!`;
  else if (count === 5) msg = `⚡ ${song.artist.toUpperCase()} OWNS THIS FLOOR!! 5 SPINS!`;
  else if (count === 10) msg = `💥 10 PLAYS!!! ${song.title.toUpperCase()} IS THE ANTHEM!!`;
  else if (count === 20) msg = `⬡ 20 PLAYS!! ${song.title.toUpperCase()} — CERTIFIED HIT!`;
  else if (count === 50) msg = `◈ LEGEND STATUS — 50 SPINS: ${song.title.toUpperCase()}`;
  else if (count > 2 && count % 10 === 0) msg = `🎧 ${count}x PLAYS — ${song.title.toUpperCase()}`;
  if (msg) setTimeout(() => showShoutout(msg, 4000), 500);
}
async function updatePlayCountBadge(song, badgeEl, knownCount) {
  if (!song) { badgeEl.textContent = ""; return; }
  const count = knownCount !== undefined ? knownCount : ((await idbGet("djPlayCounts", song.id)) || 0);
  badgeEl.textContent = count > 0 ? `◈ PLAYED ${count}x TODAY` : "";
}
function triggerManualShoutout() {
  const playing = state.deckA.playing ? state.deckA.song : (state.deckB.playing ? state.deckB.song : null);
  let phrase;
  if (playing) {
    const templates = [
      `🎤 SHOUT OUT TO: ${playing.title.toUpperCase()}!!`,
      `🔊 ${playing.artist.toUpperCase()} IN THE BUILDING!!`,
      `⚡ THIS IS: ${playing.title.toUpperCase()}!`,
      `◈ MASSIVE TUNE FROM ${playing.artist.toUpperCase()}!!`,
    ];
    phrase = templates[Math.floor(Math.random() * templates.length)];
  } else {
    phrase = SHOUTOUT_PHRASES[Math.floor(Math.random() * SHOUTOUT_PHRASES.length)];
  }
  showShoutout(phrase, 3500);
  Visualizer.triggerBeat();
}

/* ---------------------------------------------------------------------
   Storage access / library load
   --------------------------------------------------------------------- */
async function requestAccess() {
  if (fsApiSupported()) {
    const handle = await pickDirectory().catch(() => null);
    if (!handle) return;
    state.usingFSApi = true;
    await scanHandle(handle);
  } else {
    toast("Your browser needs folder-picker support for DJ Mode.");
  }
}
els.grantBtn.onclick = requestAccess; // single handler — reassigned on resume, never a second listener

async function scanHandle(handle) {
  els.grant.querySelector("p").textContent = "Scanning your library…";
  const entries = await walkDirectory(handle, AUDIO_EXT).catch(() => []);
  buildSongList(entries);
}

function buildSongList(entries) {
  state.allSongs = [];
  state.fileRefs.clear();
  entries.forEach((e, i) => {
    const id = "dj" + i + "_" + e.path.length + "_" + e.path.slice(-8);
    const filename = e.path.split("/").pop();
    const { artist, title } = titleCaseFromFilename(filename);
    state.allSongs.push({ id, title: title || filename, artist: artist || "Unknown Artist" });
    state.fileRefs.set(id, e.handle);
  });
  els.grant.classList.add("hidden");
  els.app.classList.remove("hidden");
  setStatus(`${state.allSongs.length} SONGS IN THE KINGDOM · SELECT DECKS`);
}

async function getFile(id) {
  const ref = state.fileRefs.get(id);
  if (!ref) return null;
  if (state.usingFSApi && ref.getFile) return await ref.getFile();
  return ref;
}

/* ---------------------------------------------------------------------
   Deck engine
   --------------------------------------------------------------------- */
function deckEls(letter) {
  return letter === "A"
    ? { art: els.deckAArt, title: els.deckATitle, artist: els.deckAArtist, count: els.deckACount, play: els.deckAPlay, pitch: els.deckAPitch }
    : { art: els.deckBArt, title: els.deckBTitle, artist: els.deckBArtist, count: els.deckBCount, play: els.deckBPlay, pitch: els.deckBPitch };
}
function deckState(letter) { return letter === "A" ? state.deckA : state.deckB; }
function otherLetter(letter) { return letter === "A" ? "B" : "A"; }

function setupDeckAudioGraph(deck) {
  ensureAudioContext();
  deck.source = audioCtx.createMediaElementSource(deck.audio);
  deck.filter = audioCtx.createBiquadFilter();
  deck.filter.type = "lowshelf";
  deck.filter.frequency.value = 200;
  deck.filter.gain.value = 0;
  deck.gain = audioCtx.createGain();
  deck.gain.gain.value = letterVolume(deck === state.deckA ? "A" : "B");
  deck.source.connect(deck.filter);
  deck.filter.connect(deck.gain);
  deck.gain.connect(masterGain);
}

function letterVolume(letter) {
  const angle = state.crossfadePos * (Math.PI / 2);
  return letter === "A" ? Math.cos(angle) : Math.sin(angle);
}
function applyVolumes() {
  if (state.deckA.gain) state.deckA.gain.gain.value = letterVolume("A");
  if (state.deckB.gain) state.deckB.gain.gain.value = letterVolume("B");
}
function applyBassBoost(level) {
  const gainDb = (level / 100) * 15; // 0-15dB, analogous to BassBoost 0-1000 strength
  if (state.deckA.filter) state.deckA.filter.gain.value = gainDb;
  if (state.deckB.filter) state.deckB.filter.gain.value = gainDb;
}

async function loadDeck(letter, song) {
  const deck = deckState(letter), ui = deckEls(letter);
  deck.song = song;
  releaseDeck(letter, false);
  ui.title.textContent = song.title;
  ui.artist.textContent = song.artist;
  ui.art.innerHTML = `<img src="${generatedArt(song.title + song.artist + song.id, 120)}" alt="">`;
  deckArtUrl(song).then((url) => { if (deck.song === song) ui.art.innerHTML = `<img src="${url}" alt="">`; });
  updatePlayCountBadge(song, ui.count);
  setStatus(letter === "A" ? "⚔ LOADING DECK A..." : "◈ LOADING DECK B...");

  const file = await getFile(song.id);
  if (!file) { toast("Couldn't read that file."); return; }
  ensureAudioContext();
  const audio = new Audio();
  audio.preload = "auto";
  deck.objectUrl = URL.createObjectURL(file);
  audio.src = deck.objectUrl;
  deck.audio = audio;
  setupDeckAudioGraph(deck);

  audio.addEventListener("canplay", () => {
    deck.prepared = true;
    applyVolumes();
    setStatus(letter === "A" ? "⚔ DECK A — LOADED FOR WAR" : "◈ DECK B — LOADED FOR WAR");
    if (state.autoMixActive) playDeck(letter);
  }, { once: true });

  audio.addEventListener("ended", () => onDeckEnded(letter));
  audio.addEventListener("error", () => { deck.prepared = false; });
}

function releaseDeck(letter, resetUI) {
  const deck = deckState(letter);
  if (deck.audio) { try { deck.audio.pause(); } catch (e) {} deck.audio.src = ""; deck.audio = null; }
  if (deck.objectUrl) { URL.revokeObjectURL(deck.objectUrl); deck.objectUrl = null; }
  try { if (deck.source) deck.source.disconnect(); if (deck.filter) deck.filter.disconnect(); if (deck.gain) deck.gain.disconnect(); } catch (e) {}
  deck.source = deck.filter = deck.gain = null;
  deck.prepared = false; deck.playing = false;
  if (resetUI) {
    const ui = deckEls(letter);
    ui.title.textContent = "No track loaded"; ui.artist.textContent = "Tap select";
    ui.art.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/></svg>';
    ui.count.textContent = ""; deck.song = null;
  }
}

function playDeck(letter) {
  const deck = deckState(letter), ui = deckEls(letter);
  if (!deck.audio || !deck.prepared) return;
  if (audioCtx.state === "suspended") audioCtx.resume();
  deck.audio.play().catch(() => {});
  deck.playing = true;
  ui.play.textContent = "⏸ PAUSE"; ui.play.classList.add("playing");
  applyVolumes();
  incrementAndCheckShoutout(deck.song, letter === "A");
  setStatus(letter === "A" ? "⚔ DECK A — BATTLE READY" : "◈ DECK B — BATTLE READY");
  Visualizer.triggerBeat();
}
function pauseDeck(letter) {
  const deck = deckState(letter), ui = deckEls(letter);
  if (deck.audio && deck.prepared) deck.audio.pause();
  deck.playing = false;
  ui.play.textContent = "▶ PLAY"; ui.play.classList.remove("playing");
  setStatus(letter === "A" ? "⚔ DECK A — STANDBY" : "◈ DECK B — STANDBY");
}
function cueDeck(letter) {
  const deck = deckState(letter);
  if (deck.audio && deck.prepared) { deck.audio.currentTime = 0; setStatus(letter === "A" ? "⚔ DECK A — CUE MARKED" : "◈ DECK B — CUE POINT SET"); }
}

function onDeckEnded(letter) {
  const deck = deckState(letter), ui = deckEls(letter);
  deck.playing = false; ui.play.textContent = "▶ PLAY"; ui.play.classList.remove("playing");
  if (state.autoMixActive) {
    scheduleAutoMixCrossfade(letter === "A");
  } else if (state.djQueue.length) {
    const next = state.djQueue.shift();
    renderQueue();
    setStatus(letter === "A" ? "⚔ AUTO-LOADING FROM BATTLE QUEUE..." : "◈ AUTO-LOADING FROM BATTLE QUEUE...");
    showShoutout(`⚔ NEXT: ${next.title.toUpperCase()}`, 2000);
    loadDeck(letter, next).then(() => setTimeout(() => { if (deckState(letter).prepared && !deckState(letter).playing) playDeck(letter); }, 1000));
  } else {
    setStatus(letter === "A" ? "⚔ DECK A — TRACK ENDED" : "◈ DECK B — TRACK ENDED");
  }
}

/* ---------------------------------------------------------------------
   Crossfader / pitch / bass wiring
   --------------------------------------------------------------------- */
els.crossfader.addEventListener("input", () => { state.crossfadePos = els.crossfader.value / 100; applyVolumes(); });
els.bassSlider.addEventListener("input", () => {
  state.bassLevel = Number(els.bassSlider.value);
  els.bassLabel.textContent = state.bassLevel;
  applyBassBoost(state.bassLevel);
  Visualizer.setEnergy(state.bassLevel / 100);
  if (state.bassLevel > 75) Visualizer.triggerBeat();
});
els.deckAPitch.addEventListener("input", () => { const d = state.deckA; if (d.audio && d.prepared) d.audio.playbackRate = .5 + els.deckAPitch.value / 100; });
els.deckBPitch.addEventListener("input", () => { const d = state.deckB; if (d.audio && d.prepared) d.audio.playbackRate = .5 + els.deckBPitch.value / 100; });

els.deckAPlay.addEventListener("click", () => { if (!state.deckA.song) return openPicker("A"); state.deckA.playing ? pauseDeck("A") : playDeck("A"); });
els.deckBPlay.addEventListener("click", () => { if (!state.deckB.song) return openPicker("B"); state.deckB.playing ? pauseDeck("B") : playDeck("B"); });
els.deckASelect.addEventListener("click", () => openPicker("A"));
els.deckBSelect.addEventListener("click", () => openPicker("B"));
els.deckACue.addEventListener("click", () => cueDeck("A"));
els.deckBCue.addEventListener("click", () => cueDeck("B"));

/* ---------------------------------------------------------------------
   Auto Mix
   --------------------------------------------------------------------- */
function pickNextSong(excludeId) {
  if (state.djQueue.length) { const n = state.djQueue.shift(); renderQueue(); return n; }
  if (!state.allSongs.length) return null;
  for (let tries = 0; tries < 10; tries++) {
    const candidate = state.allSongs[Math.floor(Math.random() * state.allSongs.length)];
    if (!excludeId || candidate.id !== excludeId) return candidate;
  }
  return state.allSongs[0];
}

function toggleAutoMix() {
  state.autoMixActive = !state.autoMixActive;
  els.btnAutoMix.classList.toggle("on", state.autoMixActive);
  els.btnAutoMix.textContent = state.autoMixActive ? "⚔ AUTO ON" : "AUTO MIX";
  if (state.autoMixActive) { setStatus("⚔ AUTO MIX — THE REALM FLOWS"); startAutoMix(); }
  else setStatus("⚔ AUTO MIX — DISENGAGED");
}
async function startAutoMix() {
  if (!state.allSongs.length) return;
  if (!state.deckA.song) await loadDeck("A", pickNextSong(null));
  if (!state.deckB.song) setTimeout(() => loadDeck("B", pickNextSong(state.deckA.song && state.deckA.song.id)), 500);
  setTimeout(() => { if (state.deckA.prepared) playDeck("A"); }, 1500);
}
function tweenCrossfade(target, durationMs, onEnd) {
  const start = state.crossfadePos, t0 = performance.now();
  function step(t) {
    const p = Math.min(1, (t - t0) / durationMs);
    state.crossfadePos = start + (target - start) * p;
    els.crossfader.value = Math.round(state.crossfadePos * 100);
    applyVolumes();
    if (p < 1) requestAnimationFrame(step); else if (onEnd) onEnd();
  }
  requestAnimationFrame(step);
}
function scheduleAutoMixCrossfade(deckAFinished) {
  setStatus("⚔ CROSSING OVER THE NARROW SEA...");
  showShoutout("⚔ THE NEXT HOUSE RISES! ⚔", 2000);
  Visualizer.triggerBeat();
  const fullMs = state.crossfadeDurationS * 1000 || 3000;
  const easeMs = Math.round(fullMs * 1.33);
  if (deckAFinished) {
    tweenCrossfade(1, fullMs, async () => {
      const next = pickNextSong(state.deckB.song && state.deckB.song.id);
      if (next) { await loadDeck("A", next); setTimeout(() => { if (state.deckA.prepared) { playDeck("A"); tweenCrossfade(.5, easeMs, null); } }, 2000); }
    });
  } else {
    tweenCrossfade(0, fullMs, async () => {
      const next = pickNextSong(state.deckA.song && state.deckA.song.id);
      if (next) { await loadDeck("B", next); setTimeout(() => { if (state.deckB.prepared) { playDeck("B"); tweenCrossfade(.5, easeMs, null); } }, 2000); }
    });
  }
}
els.btnAutoMix.addEventListener("click", toggleAutoMix);

/* ---------------------------------------------------------------------
   Beat Sync
   --------------------------------------------------------------------- */
let beatSyncTimeout = null;
function toggleBeatSync() {
  state.beatSyncActive = !state.beatSyncActive;
  els.btnBeatSync.classList.toggle("on", state.beatSyncActive);
  els.btnBeatSync.textContent = state.beatSyncActive ? "⚔ BEAT ON" : "BEAT SYNC";
  if (state.beatSyncActive) startBeatSync(); else clearTimeout(beatSyncTimeout);
}
function startBeatSync() {
  function tick() {
    if (!state.beatSyncActive) return;
    Visualizer.triggerBeat();
    beatSyncTimeout = setTimeout(tick, 400 + Math.random() * 200);
  }
  tick();
}
els.btnBeatSync.addEventListener("click", toggleBeatSync);
els.btnShoutout.addEventListener("click", triggerManualShoutout);

/* ---------------------------------------------------------------------
   Energy updater
   --------------------------------------------------------------------- */
setInterval(() => {
  let e = state.bassLevel / 100;
  if (state.deckA.playing && state.deckB.playing) e = Math.min(1, e + .3);
  else if (state.deckA.playing || state.deckB.playing) e = Math.min(1, e + .15);
  Visualizer.setEnergy(e);
}, 100);

/* ---------------------------------------------------------------------
   Queue
   --------------------------------------------------------------------- */
function renderQueue() {
  if (!state.djQueue.length) { els.queueList.innerHTML = '<div class="queue-empty">Queue is empty — add tracks to auto-load when a deck finishes.</div>'; return; }
  els.queueList.innerHTML = state.djQueue.map((s, i) => `
    <div class="queue-row" data-idx="${i}">
      <span class="t">▶ ${escapeHtml(s.title)}</span>
      <span class="a">${escapeHtml(s.artist)}</span>
      <button class="rm" data-remove="${i}">✕</button>
    </div>`).join("");
}
els.queueList.addEventListener("click", (e) => {
  const rmBtn = e.target.closest("[data-remove]");
  if (rmBtn) { state.djQueue.splice(Number(rmBtn.dataset.remove), 1); renderQueue(); return; }
  const row = e.target.closest(".queue-row");
  if (row) {
    const idx = Number(row.dataset.idx);
    const song = state.djQueue[idx];
    if (!state.deckA.prepared || !state.deckA.playing) {
      state.djQueue.splice(idx, 1); renderQueue();
      loadDeck("A", song).then(() => setTimeout(() => { if (state.deckA.prepared && !state.deckA.playing) playDeck("A"); }, 1200));
    } else if (!state.deckB.prepared || !state.deckB.playing) {
      state.djQueue.splice(idx, 1); renderQueue();
      loadDeck("B", song).then(() => setTimeout(() => { if (state.deckB.prepared && !state.deckB.playing) playDeck("B"); }, 1200));
    } else {
      toast("⚔ BOTH DECKS ACTIVE — USE ✕ TO REMOVE");
    }
  }
});
els.addQueueBtn.addEventListener("click", () => openPicker("queue"));

/* ---------------------------------------------------------------------
   Song picker modal
   --------------------------------------------------------------------- */
function openPicker(target) {
  state.pickerTarget = target;
  els.pickerTitle.textContent = target === "A" ? "⚔ LOAD DECK A" : target === "B" ? "◈ LOAD DECK B" : "⚔ ADD TO BATTLE QUEUE";
  els.pickerSearch.value = "";
  renderPickerList("");
  els.pickerOverlay.classList.add("open");
  els.pickerSearch.focus();
}
function renderPickerList(q) {
  const query = q.trim().toLowerCase();
  const list = state.allSongs.filter(s => !query || s.title.toLowerCase().includes(query) || s.artist.toLowerCase().includes(query)).slice(0, 200);
  els.pickerList.innerHTML = list.length
    ? list.map(s => `<div class="dj-modal-row" data-id="${s.id}"><span>${escapeHtml(s.title)}</span><span class="a">${escapeHtml(s.artist)}</span></div>`).join("")
    : `<div class="dj-modal-row" style="color:#666;">No matches.</div>`;
}
els.pickerSearch.addEventListener("input", () => renderPickerList(els.pickerSearch.value));
els.pickerList.addEventListener("click", (e) => {
  const row = e.target.closest("[data-id]");
  if (!row) return;
  const song = state.allSongs.find(s => s.id === row.dataset.id);
  if (!song) return;
  if (state.pickerTarget === "queue") { state.djQueue.push(song); renderQueue(); toast(`⚔ QUEUED: ${song.title}`); }
  else loadDeck(state.pickerTarget, song);
  els.pickerOverlay.classList.remove("open");
});
els.pickerCloseBtn.addEventListener("click", () => els.pickerOverlay.classList.remove("open"));
els.pickerOverlay.addEventListener("click", (e) => { if (e.target === els.pickerOverlay) els.pickerOverlay.classList.remove("open"); });

/* ---------------------------------------------------------------------
   Visual theme cycling
   --------------------------------------------------------------------- */
function cycleVisualTheme() {
  const next = (Visualizer.getTheme() + 1) % THEMES.length;
  Visualizer.setTheme(next);
  idbSet("kv", "djVisualTheme", next);
  showShoutout(`⬡ VISUAL: ${THEMES[next].name}`, 1500);
  els.visualThemeName.textContent = THEMES[next].name;
}
els.visualBtn.addEventListener("click", cycleVisualTheme);

/* ---------------------------------------------------------------------
   DJ Settings modal
   --------------------------------------------------------------------- */
function openSettings() {
  els.visualThemeName.textContent = THEMES[Visualizer.getTheme()].name;
  els.crossfadeDurLabel.textContent = state.crossfadeDurationS === 0 ? "OFF" : state.crossfadeDurationS + "s";
  els.settingsOverlay.classList.add("open");
}
els.settingsBtn.addEventListener("click", openSettings);
els.settingsCloseBtn.addEventListener("click", () => els.settingsOverlay.classList.remove("open"));
els.settingsOverlay.addEventListener("click", (e) => { if (e.target === els.settingsOverlay) els.settingsOverlay.classList.remove("open"); });

els.optVisualTheme.addEventListener("click", () => { cycleVisualTheme(); els.settingsOverlay.classList.remove("open"); });
els.optCrossfade.addEventListener("click", () => {
  const opts = [0, 2, 4, 6, 8, 10];
  const idx = opts.indexOf(state.crossfadeDurationS);
  const next = opts[(idx + 1 + opts.length) % opts.length];
  state.crossfadeDurationS = next;
  idbSet("kv", "djCrossfadeDuration", next);
  els.crossfadeDurLabel.textContent = next === 0 ? "OFF" : next + "s";
  toast(`⚔ CROSSFADE: ${next === 0 ? "OFF (0s)" : next + " seconds"}`);
});
els.optBassPreset.addEventListener("click", () => {
  const opts = [0, 25, 50, 75, 100];
  const idx = opts.indexOf(state.bassLevel);
  const next = opts[(idx + 1 + opts.length) % opts.length] ?? 50;
  state.bassLevel = next; els.bassSlider.value = next; els.bassLabel.textContent = next;
  applyBassBoost(next); idbSet("kv", "djBassLevel", next);
  toast(`⚔ BASS: ${next}%`);
});
els.optResetCounts.addEventListener("click", async () => {
  const keys = await idbGetAllKeys("djPlayCounts");
  await Promise.all(keys.map(k => idbDelete("djPlayCounts", k)));
  updatePlayCountBadge(state.deckA.song, els.deckACount);
  updatePlayCountBadge(state.deckB.song, els.deckBCount);
  toast("⚔ ALL PLAY COUNTS RESET");
});
els.optClearQueue.addEventListener("click", () => { state.djQueue = []; renderQueue(); toast("⚔ QUEUE CLEARED"); });
els.optAbout.addEventListener("click", () => { els.settingsOverlay.classList.remove("open"); els.aboutOverlay.classList.add("open"); });
els.aboutCloseBtn.addEventListener("click", () => els.aboutOverlay.classList.remove("open"));
els.aboutOverlay.addEventListener("click", (e) => { if (e.target === els.aboutOverlay) els.aboutOverlay.classList.remove("open"); });

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
async function boot() {
  Visualizer.init(document.getElementById("djVisualizer"));
  const [savedTheme, savedCrossfade, savedBass] = await Promise.all([
    idbGet("kv", "djVisualTheme"), idbGet("kv", "djCrossfadeDuration"), idbGet("kv", "djBassLevel"),
  ]);
  if (typeof savedTheme === "number") Visualizer.setTheme(savedTheme);
  if (typeof savedCrossfade === "number") state.crossfadeDurationS = savedCrossfade;
  if (typeof savedBass === "number") { state.bassLevel = savedBass; els.bassSlider.value = savedBass; els.bassLabel.textContent = savedBass; }

  const handle = await getStoredHandle();
  if (handle) {
    const granted = await verifyPermission(handle, false);
    if (granted) { state.usingFSApi = true; await scanHandle(handle); return; }
    els.grantBtn.textContent = "Resume Access & Enter DJ Mode";
    els.grantBtn.onclick = async () => {
      const ok = await verifyPermission(handle, true);
      if (ok) { state.usingFSApi = true; await scanHandle(handle); } else toast("Access wasn't granted.");
    };
  }
}
boot();
})();
