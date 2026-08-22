/* =========================================================================
   VVYNAS VANE — WEB
   A local-first music player. Every file you play stays on your device —
   this app never uploads, streams, or transmits your library anywhere.
   ========================================================================= */

(() => {
"use strict";

/* ---------------------------------------------------------------------
   IndexedDB — delegated to shared.js (VV) so index/video/recap pages
   never open the database at different versions and block each other.
   --------------------------------------------------------------------- */
const { idbGet, idbSet, idbDelete, idbGetAll, idbGetAllKeys, idbGetAllEntries, idbPut, openDB } = window.VV;

/* ---------------------------------------------------------------------
   State
   --------------------------------------------------------------------- */
// Recognized audio extensions live in shared.js (window.VV.AUDIO_EXT) so
// the main library scan, DJ Mode's scan, and the folder-picker fallback
// all agree on what counts as "a song" — see the comment there for the
// full list and rationale.
const AUDIO_EXT = window.VV.AUDIO_EXT;
const RECENT_CAP = 100;

const state = {
  songs: [],            // {id, title, artist, album, folder, ext, duration, size, dateAdded, year, handleRef}
  foldersMap: new Map(), // folder path -> [songIds]
  playlists: [],         // {id, name, songIds:[]}
  favorites: new Set(),
  playCounts: new Map(),
  recentlyPlayed: [],    // [{id, playedAt}] most-recent-first, capped at RECENT_CAP
  selectMode: false,
  selectedIds: new Set(),
  playlistModalMode: "create", // "create" | "rename"
  renameTargetId: null,
  currentView: "songs",
  currentFolder: null,
  currentPlaylist: null,
  search: "",
  sort: "title",
  queue: [],             // array of song ids, current playback order
  queueIndex: -1,
  shuffle: false,
  repeat: "off",         // off | all | one
  isPlaying: false,
  addToPlaylistTargetId: null,
  settings: { light: false, resume: true, fontStyle: 0, themeId: "none", accentColor: "#C9A84C", accent2Color: "#B22222", artStyle: "sigil", rageMode: false, rageBackground: "none", rageDripType: "smoke", overlayStrength: 55 },
  usingFSApi: false,
  fileRefs: new Map(),   // songId -> File or FileSystemFileHandle
  objectUrl: null,
  artCache: new Map(),   // unused (kept for backward compat with any external references)
  customArt: new Map(),  // songId -> custom album art data URL (uploaded from device), see loadUserData
  embeddedArt: new Map(), // songId -> the song file's own cover art, extracted from its tag (see loadUserData / loadMetadataProgressively)
};

const audio = new Audio();
audio.preload = "metadata";

/* ---------------------------------------------------------------------
   DOM shortcuts
   --------------------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  onboarding: $("#onboarding"),
  appBody: $("#appBody"),
  grantAccessBtn: $("#grantAccessBtn"),
  fsApiNote: $("#fsApiNote"),
  sidebar: $("#sidebar"),
  navItems: $$(".nav-item"),
  tabbarBtns: $$(".tabbar button"),
  tabbar: $("#tabbar"),
  viewTitle: $("#viewTitle"),
  searchInput: $("#searchInput"),
  sortSelect: $("#sortSelect"),
  shuffleAllBtn: $("#shuffleAllBtn"),
  contentScroll: $("#contentScroll"),
  viewSongs: $("#view-songs"),
  viewPlaylists: $("#view-playlists"),
  viewPlaylistDetail: $("#view-playlist-detail"),
  viewFolders: $("#view-folders"),
  viewFolderDetail: $("#view-folder-detail"),
  viewFavorites: $("#view-favorites"),
  viewRecent: $("#view-recent"),
  storageLabel: $("#storageLabel"),
  rescanBtn: $("#rescanBtn"),
  installSidebarBtn: $("#installSidebarBtn"),
  settingsBtn: $("#settingsBtn"),
  folderFallbackInput: $("#folderFallbackInput"),

  miniPlayer: $("#miniPlayer"),
  miniArt: $("#miniArt"),
  miniTitle: $("#miniTitle"),
  miniArtist: $("#miniArtist"),
  miniPlayBtn: $("#miniPlayBtn"),
  miniPlayIcon: $("#miniPlayIcon"),
  miniPrevBtn: $("#miniPrevBtn"),
  miniNextBtn: $("#miniNextBtn"),
  miniProgressFill: $("#miniProgressFill"),

  playerOverlay: $("#playerOverlay"),
  playerCollapseBtn: $("#playerCollapseBtn"),
  playerQueueTopBtn: $("#playerQueueTopBtn"),
  playerArt: $("#playerArt"),
  editArtBtn: $("#editArtBtn"),
  resetArtBtn: $("#resetArtBtn"),
  albumArtUploadInput: $("#albumArtUploadInput"),
  playerTitle: $("#playerTitle"),
  playerArtist: $("#playerArtist"),
  playerSourceLabel: $("#playerSourceLabel"),
  seekTrack: $("#seekTrack"),
  seekFill: $("#seekFill"),
  seekHandle: $("#seekHandle"),
  curTime: $("#curTime"),
  totalTime: $("#totalTime"),
  shuffleBtn: $("#shuffleBtn"),
  prevBtn: $("#prevBtn"),
  playBtn: $("#playBtn"),
  playIcon: $("#playIcon"),
  nextBtn: $("#nextBtn"),
  repeatBtn: $("#repeatBtn"),
  favBtn: $("#favBtn"),
  addToPlaylistBtn: $("#addToPlaylistBtn"),
  queueBtn: $("#queueBtn"),

  sheetOverlay: $("#sheetOverlay"),
  queueSheet: $("#queueSheet"),
  closeQueueBtn: $("#closeQueueBtn"),
  queueList: $("#queueList"),

  playlistModalOverlay: $("#playlistModalOverlay"),
  playlistPickList: $("#playlistPickList"),
  newPlaylistFromModalBtn: $("#newPlaylistFromModalBtn"),
  closePlaylistModalBtn: $("#closePlaylistModalBtn"),

  newPlaylistModalOverlay: $("#newPlaylistModalOverlay"),
  newPlaylistModalTitle: $("#newPlaylistModalTitle"),
  newPlaylistInput: $("#newPlaylistInput"),
  cancelNewPlaylistBtn: $("#cancelNewPlaylistBtn"),
  confirmNewPlaylistBtn: $("#confirmNewPlaylistBtn"),

  settingsModalOverlay: $("#settingsModalOverlay"),
  lightModeSwitch: $("#lightModeSwitch"),
  resumeSwitch: $("#resumeSwitch"),
  accentColorInput: $("#accentColorInput"), accentColorHex: $("#accentColorHex"),
  accent2ColorInput: $("#accent2ColorInput"), accent2ColorHex: $("#accent2ColorHex"),
  resetColorsBtn: $("#resetColorsBtn"),
  rageModeSwitch: $("#rageModeSwitch"),
  closeSettingsBtn: $("#closeSettingsBtn"),
  settingsRescanBtn: $("#settingsRescanBtn"),
  overlayStrengthInput: $("#overlayStrengthInput"),
  overlayStrengthValue: $("#overlayStrengthValue"),

  iosModalOverlay: $("#iosModalOverlay"),
  closeIosModalBtn: $("#closeIosModalBtn"),

  toast: $("#toast"),
};

/* ---------------------------------------------------------------------
   Utilities
   --------------------------------------------------------------------- */
function toast(msg, ms = 2400) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("show"), ms);
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function fmtSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}
function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
  return "s" + Math.abs(h).toString(36) + str.length.toString(36);
}
function titleCaseFromFilename(name) {
  const noExt = name.replace(AUDIO_EXT, "");
  const cleaned = noExt.replace(/[_]+/g, " ").trim();
  const m = cleaned.match(/^(.{1,60}?)\s*-\s*(.{1,80})$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: "", title: cleaned };
}

/* Album art rendering — priority order is: 1) a custom photo uploaded
   from device storage (Settings-free — set via the full player's
   edit-art button), 2) the song file's OWN embedded cover art (read
   straight out of its ID3v2/FLAC/MP4 tag the first time its metadata is
   scanned — see loadMetadataProgressively/getEmbeddedArtForFile in
   shared.js), so the real album art is what shows by default, and only
   3) a generated placeholder for songs that have no embedded picture at
   all, which delegates to window.VV.generatedArt so it always reflects
   the currently selected Album Art Style. */
function resolveArtUrl(song) {
  return state.customArt.get(song.id) || state.embeddedArt.get(song.id) || window.VV.generatedArt(song.title + song.artist + song.id, 160);
}
function artHtml(song, sizeAttr = "") {
  const url = resolveArtUrl(song);
  return `<img src="${url}" alt="" loading="lazy">`;
}

/* ---------------------------------------------------------------------
   Animated background (42 themes), globe title, pixie dust, book transition
   — all ported 1:1 from the Android app's view classes; see shared.js.
   --------------------------------------------------------------------- */
window.VV.ThemeEngine.init(document.getElementById("themeCanvas"));
/* ---------------------------------------------------------------------
   Heart-pulse wordmark — Rage Mode's stylized alternative to the globe
   title. A simple pulsing heart glyph (not anatomical/graphic) with an
   ECG-style pulse line and "VVYNAS VANE" arced around it, in the same
   restrained style as the rest of the icon set.
   --------------------------------------------------------------------- */
const HeartTitle = (() => {
  let canvas, ctx, W = 0, H = 0, raf = null, t = 0;
  function resize() { if (!canvas) return; W = canvas.width = canvas.clientWidth; H = canvas.height = canvas.clientHeight; }
  function heartPath(cx, cy, s) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + s * .3);
    ctx.bezierCurveTo(cx - s, cy - s * .6, cx - s * .4, cy - s * 1.2, cx, cy - s * .4);
    ctx.bezierCurveTo(cx + s * .4, cy - s * 1.2, cx + s, cy - s * .6, cx, cy + s * .3);
    ctx.closePath();
  }
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!ctx || W === 0 || H === 0) return;
    t += 0.02;
    ctx.clearRect(0, 0, W, H);
    const beat = Math.max(0, Math.sin(t * 2.6)) ** 6; // sharp pulse, not a smooth sine
    const cx = W * .18, cy = H * .5, s = H * .16 * (1 + beat * .18);
    ctx.save();
    ctx.shadowColor = "rgba(255,40,20,0.8)"; ctx.shadowBlur = 8 + beat * 14;
    ctx.fillStyle = `rgba(220,20,20,${0.85 + beat * .15})`;
    heartPath(cx, cy, s); ctx.fill();
    ctx.restore();
    // ECG pulse line trailing to the right of the heart
    ctx.strokeStyle = "rgba(255,80,40,0.8)"; ctx.lineWidth = 1.6; ctx.beginPath();
    const baseY = H * .5, startX = W * .3;
    ctx.moveTo(startX, baseY);
    for (let x = startX; x < W; x += 2) {
      const p = ((x - startX + t * 60) % (W * .5)) / (W * .5);
      let y = baseY;
      if (p > .42 && p < .5) y = baseY - (p - .42) * 8 * s;
      else if (p >= .5 && p < .58) y = baseY - s * .34 + (p - .5) * 14 * s;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    // wordmark
    ctx.fillStyle = "rgba(255,235,225,0.92)";
    ctx.font = `700 13px 'Courier New', monospace`;
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("VVYNAS VANE", W * .34, H * .5);
  }
  function init(canvasEl) { canvas = canvasEl; ctx = canvas.getContext("2d"); resize(); window.addEventListener("resize", resize); if (!raf) frame(); }
  return { init };
})();

window.VV.GlobeTitle.init(document.getElementById("globeTitleCanvas"));
HeartTitle.init(document.getElementById("heartTitleCanvas"));
window.VV.PixieDust.init(document.getElementById("pixieCanvas"));
window.VV.BookTransition.init("bookTransition");

const RAVEN_LINES = ["RAVENS DISPATCHED...", "SCROLLS UNSEALED", "THE LIBRARY AWAITS", "SONGS OF WESTEROS"];
const RAGE_LINES = ["THE CROWD ROARS", "BASS INCOMING", "FEEL THE DROP", "PYRO ARMED", "SUB-BASS ENGAGED", "MOSH PIT ACTIVE", "TURN IT UP", "ENERGY MAXED"];

/* ---------------------------------------------------------------------
   Background images — four selectable full-screen backdrops (Settings →
   🖼 Background Image). Previously these only ever showed while Rage
   Mode was on; they now apply in every mode — Light, Dark, and Rage —
   since #rageBgLayer's display is no longer gated by html.rage-active
   in style.css. Files sit flat alongside the other app assets (no
   subfolder), so dropping in replacement art just means overwriting
   these four filenames. When "None" is selected: in Rage Mode this
   falls back to the built-in canvas-drawn Demon's Den scene as before;
   in Light/Dark mode it just falls back to the normal animated theme
   background. The smoke / ember / eyes canvas layer (Rage Mode only)
   always renders on TOP of whichever background is chosen.
   --------------------------------------------------------------------- */
const RAGE_BACKGROUNDS = [
  { id: "none", label: "None (default)" },
  { id: "bg1", label: "Atomic 1", file: "Atomic1_0.jpeg" },
  { id: "bg2", label: "Atomic 2", file: "Atomic2_0.jpeg" },
  { id: "bg3", label: "Hell 1", file: "Hell1_0.jpeg" },
  { id: "bg4", label: "Hell 2", file: "Hell2_0.jpeg" },
];
/* A user-uploaded background photo (Settings → 🖼 Background Image →
   Upload Photo). The file itself is stored as a Blob in IndexedDB
   ("kv"/"customBgImage") so it survives reloads; customBgObjectUrl is
   just the in-memory object URL created from that Blob for the current
   page load, revoked and recreated whenever the photo changes. Selecting
   it sets state.settings.rageBackground = "custom", same as any preset. */
const CUSTOM_BG_MAX_BYTES = 8 * 1024 * 1024; // 8MB cap for user-uploaded photos (background image + custom album art) — keeps IndexedDB snappy
let customBgObjectUrl = null;

/* ---------------------------------------------------------------------
   Custom video background — Settings → Animated Background lets the
   user pick a video from device storage to use as the animated
   background instead of one of the 42 built-in canvas themes. Stored as
   a Blob in IndexedDB ("kv"/"customBgVideo") so it survives reloads;
   customBgVideoObjectUrl is the in-memory object URL for the current
   page load. Selecting it sets state.settings.themeId = "customVideo",
   which — since that id isn't one of ThemeEngine's known themes —
   already makes the canvas draw nothing on its own; applyThemeVideo()
   below just shows the <video> layer on top whenever that id is active.
   --------------------------------------------------------------------- */
const CUSTOM_BG_VIDEO_MAX_BYTES = 60 * 1024 * 1024; // 60MB cap — generous for a short looping clip, keeps IndexedDB usable
let customBgVideoObjectUrl = null;

/* ---------------------------------------------------------------------
   Rage Mode ambience effect — what billows across the screen. "Intense
   Smoke" (default) fills the screen with thick, dense, dark smoke;
   "None" turns the effect off. There is no flame/fire or dripping
   effect. Only relevant while Rage Mode is on (Settings → Ambience).
   --------------------------------------------------------------------- */
const RAGE_DRIP_TYPES = [
  { id: "smoke", label: "💨 Intense Smoke" },
  { id: "none", label: "Off" },
];
let rageLineIdx = 0, rageLineTimer = null;
function updateRavensLine() {
  const el = document.getElementById("ravensLine");
  if (!el) return;
  if (RageMode.active) return; // RageMode drives this line itself while on
  el.textContent = state.songs.length ? `${state.songs.length} SONG${state.songs.length === 1 ? "" : "S"} CATALOGUED` : RAVEN_LINES[0];
}

/* ---------------------------------------------------------------------
   RAGE MODE — an alternate, audio-reactive full-app skin. Reads real
   frequency data from whatever is actually playing (via a Web Audio
   AnalyserNode tapped off the main <audio> element) and drives an ember
   canvas, a screen-impact shake, and a flash burst on bass hits —
   spanning the whole app, not just the player. See style.css for the
   `html.rage-active` rules that make the app chrome translucent so the
   canvas shows through everywhere.
   --------------------------------------------------------------------- */
const RageMode = (() => {
  let canvas, ctx, W = 0, H = 0, raf = null, active = false;
  let audioCtx = null, analyser = null, dataArray = null, sourceConnected = false;
  let embers = [], bassAvg = 0, bassRolling = 0.08, lastFlash = 0;
  let demonEyes = [], denSkulls = [], chains = [], toxicPool = null, denInitialized = false;
  let bgActive = false;
  let smokeParticles = [], dripType = "smoke"; // dripType: "smoke" | "none"
  const EMBER_COUNT = 70, SMOKE_COUNT = 20, SMOKE_COUNT_INTENSE = 46;

  function resize() { if (!canvas) return; W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }

  function spawnEmber(e) {
    e.x = Math.random() * W; e.y = H + 10 + Math.random() * 40;
    e.vy = -(0.6 + Math.random() * 1.8); e.vx = (Math.random() - 0.5) * 0.6;
    e.r = 1 + Math.random() * 3; e.life = 0; e.max = 260 + Math.random() * 260;
    e.hue = Math.random() < 0.15 ? "green" : "ember"; // rare toxic-green ember, nod to the biohazard art style
  }

  function spawnSmoke(p) {
    p.x = Math.random() * W; p.y = H + 30 + Math.random() * 80;
    p.r = 46 + Math.random() * 130;
    p.vy = -(0.3 + Math.random() * 0.6); p.vx = (Math.random() - 0.5) * 0.4;
    p.life = 0; p.max = 420 + Math.random() * 380;
    p.alpha = 0.1 + Math.random() * 0.16;
    p.sway = Math.random() * Math.PI * 2;
  }
  /** Rebuilds the smoke particle pool. Pass true for the dense
   *  "Intense Smoke" drip effect (more, bigger, darker plumes); false/
   *  omitted keeps the thinner ambient count. */
  function initSmoke(intense) {
    const count = intense ? SMOKE_COUNT_INTENSE : SMOKE_COUNT;
    smokeParticles = Array.from({ length: count }, () => { const p = {}; spawnSmoke(p); p.life = Math.random() * p.max; return p; });
  }
  /** Thick, billowing smoke — the "Intense Smoke" drip effect. Renders as
   *  dense, dark, overlapping plumes rolling up the whole screen instead
   *  of any drip strands. */
  function drawSmoke() {
    smokeParticles.forEach(p => {
      p.y += p.vy * (1 + bassAvg * 0.6); p.x += p.vx + Math.sin(p.life * 0.01 + p.sway) * 0.25; p.life++;
      if (p.y < -p.r - 30 || p.life > p.max) spawnSmoke(p);
      const fadeIn = Math.min(1, p.life / 40);
      const fadeOut = Math.max(0, 1 - Math.max(0, p.life - p.max * 0.7) / (p.max * 0.3));
      const a = p.alpha * fadeIn * fadeOut * (1 + bassAvg * 0.5);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      g.addColorStop(0, `rgba(50,45,42,${a})`); g.addColorStop(0.6, `rgba(30,26,24,${a * 0.7})`); g.addColorStop(1, "rgba(20,16,15,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    });
  }

  function initDenScene() {
    denInitialized = true;
    initSmoke(dripType === "smoke");
    // A couple of half-lit skulls resting low in the dark, like something
    // half-buried in the den floor — decorative, low alpha, not blocking UI.
    denSkulls = [
      { x: W * 0.1, y: H * 0.94, r: Math.min(W, H) * 0.09, alpha: 0.5, popped: -1 },
      { x: W * 0.9, y: H * 0.97, r: Math.min(W, H) * 0.075, alpha: 0.4, popped: 1 },
    ];
    // Pairs of glowing eyes lurking in the unlit corners.
    demonEyes = [
      { x: W * 0.06, y: H * 0.18, gap: 14, phase: 0 },
      { x: W * 0.94, y: H * 0.26, gap: 12, phase: 1.7 },
      { x: W * 0.5, y: H * 0.08, gap: 16, phase: 3.1 },
    ];
    // Rusted chains hanging from off-screen, and a toxic pool with a
    // half-submerged skull near the bottom — the "Chernobyl den" floor.
    chains = Array.from({ length: 5 }, (_, i) => ({
      x: (W / 5) * i + (W / 10), len: H * (0.12 + Math.random() * 0.16), sway: Math.random() * Math.PI * 2,
    }));
    toxicPool = { cx: W * 0.72, cy: H * 0.9, rx: Math.min(W, H) * 0.22, ry: Math.min(W, H) * 0.055 };
  }

  function drawRuinSkyline() {
    // Faint silhouette of ruined cooling towers + a skeletal ferris wheel
    // fading into the fog on the horizon — pure atmosphere, very low alpha.
    const baseY = H * 0.62;
    ctx.fillStyle = "rgba(40,45,50,0.22)";
    // cooling tower silhouette
    ctx.beginPath();
    ctx.moveTo(W * 0.08, baseY); ctx.bezierCurveTo(W * 0.1, baseY - H * .14, W * 0.16, baseY - H * .14, W * 0.18, baseY);
    ctx.closePath(); ctx.fill();
    ctx.fillRect(W * 0.22, baseY - H * .1, W * 0.02, H * .1);
    // distant ferris wheel — thin ring + spokes
    ctx.strokeStyle = "rgba(50,55,60,0.18)"; ctx.lineWidth = 1.5;
    const fx = W * 0.85, fy = baseY - H * .07, fr = H * .07;
    ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.stroke();
    for (let s = 0; s < 8; s++) { const a = (s / 8) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + Math.cos(a) * fr, fy + Math.sin(a) * fr); ctx.stroke(); }
  }

  function drawChains(t) {
    ctx.strokeStyle = "rgba(70,65,60,0.55)"; ctx.lineWidth = 3;
    chains.forEach((c, i) => {
      const swayX = Math.sin(t * 0.0006 + c.sway) * (6 + bassAvg * 6);
      ctx.beginPath(); ctx.moveTo(c.x, -10);
      for (let l = 0; l <= c.len; l += 14) { ctx.lineTo(c.x + swayX * (l / c.len), l); }
      ctx.stroke();
      // link glints
      ctx.fillStyle = "rgba(110,100,90,0.4)";
      for (let l = 0; l <= c.len; l += 28) ctx.fillRect(c.x + swayX * (l / c.len) - 2, l, 4, 4);
    });
  }

  function drawToxicPool() {
    const p = toxicPool;
    const g = ctx.createRadialGradient(p.cx, p.cy, 2, p.cx, p.cy, p.rx);
    g.addColorStop(0, `rgba(90,255,60,${0.28 + bassAvg * 0.15})`); g.addColorStop(0.6, "rgba(40,120,20,0.18)"); g.addColorStop(1, "rgba(20,60,10,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(p.cx, p.cy, p.rx, p.ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.ellipse(p.cx, p.cy, p.rx * .96, p.ry * .96, 0, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = "rgba(10,25,5,0.5)"; ctx.fillRect(p.cx - p.rx, p.cy, p.rx * 2, p.ry * 1.4);
    // half-submerged skull: draw it clipped to only show the top half above the "surface"
    window.VV.drawSkullIcon(ctx, p.cx - p.rx * .15, p.cy - p.ry * .1, p.rx * .32, { alpha: 0.85, poppedSide: -1 });
    ctx.restore();
    ctx.strokeStyle = `rgba(150,255,100,${0.3 + bassAvg * 0.2})`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(p.cx, p.cy, p.rx, p.ry, 0, 0, Math.PI * 2); ctx.stroke();
  }

  function drawDemonEyes(t) {
    demonEyes.forEach(e => {
      const pulse = 0.5 + 0.5 * Math.sin(t * 0.0018 + e.phase);
      const glowA = 0.25 + pulse * 0.35 + bassAvg * 0.3;
      [-1, 1].forEach(side => {
        const ex = e.x + side * e.gap;
        const glow = ctx.createRadialGradient(ex, e.y, 0.5, ex, e.y, e.gap * 1.4);
        glow.addColorStop(0, `rgba(200,0,0,${glowA})`); glow.addColorStop(1, "rgba(200,0,0,0)");
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(ex, e.y, e.gap * 1.4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(255,40,20,${0.55 + pulse * 0.35})`;
        ctx.beginPath(); ctx.ellipse(ex, e.y, e.gap * 0.22, e.gap * 0.12, 0, 0, Math.PI * 2); ctx.fill();
      });
    });
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!active || !ctx) return;
    readBass();
    bassRolling += (bassAvg - bassRolling) * 0.04;
    const now = performance.now();
    if (bassAvg > bassRolling * 1.45 && bassAvg > 0.22 && now - lastFlash > 160) {
      lastFlash = now;
      triggerFlash();
      shakeScreen(4 + bassAvg * 10);
    }

    ctx.clearRect(0, 0, W, H);

    // 1. Base lighting. With no background image selected: the usual
    //    opaque Demon's Den cavern fill. With a background image active,
    //    the canvas is only lightly washed so the chosen image shows
    //    through underneath, with the den lighting/glow, eyes, chains,
    //    embers and blood all layered on TOP of it as before.
    if (bgActive) {
      ctx.fillStyle = "rgba(3,0,10,0.32)"; ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = "#03000A"; ctx.fillRect(0, 0, W, H);
    }
    const denGlow = ctx.createRadialGradient(W / 2, H * 0.92, 10, W / 2, H * 0.92, H * 0.85);
    denGlow.addColorStop(0, `rgba(200,40,0,${(bgActive ? 0.10 : 0.14) + bassAvg * 0.16})`); denGlow.addColorStop(0.5, "rgba(60,0,20,0.10)"); denGlow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = denGlow; ctx.fillRect(0, 0, W, H);

    // The illustrated Demon's Den set pieces (skyline, eyes, chains, pool)
    // are part of the default backdrop — skip them when a photo background
    // is chosen so they don't visually clash with it. The fire/smoke
    // drip effect and ambient embers still always render, on top of
    // whichever background is active.
    if (!bgActive) {
      drawRuinSkyline();
      drawDemonEyes(now);
      drawChains(now);
      denSkulls.forEach(s => window.VV.drawSkullIcon(ctx, s.x, s.y, s.r, { alpha: s.alpha, poppedSide: s.popped }));
      drawToxicPool();
    }

    const speedMul = 1 + bassAvg * 2.4;
    embers.forEach(e => {
      e.y += e.vy * speedMul; e.x += e.vx + Math.sin(e.life * 0.05) * 0.4; e.life++;
      if (e.y < -20 || e.life > e.max) spawnEmber(e);
      const fade = Math.max(0, 1 - e.life / e.max);
      const glow = e.hue === "green" ? `rgba(80,255,60,${0.55 * fade})` : `rgba(255,${100 + Math.floor(bassAvg * 100)},20,${0.7 * fade})`;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (1 + bassAvg * 0.8), 0, Math.PI * 2);
      ctx.fillStyle = glow; ctx.fill();
    });

    // "Intense Smoke" fills the screen with dense, dark smoke. "None"
    // draws nothing here.
    if (dripType === "smoke") drawSmoke();

    // final concentration pass — darker toward the edges, brightest low-center
    const vig = ctx.createRadialGradient(W / 2, H * 0.6, H * 0.25, W / 2, H * 0.6, H * 0.85);
    vig.addColorStop(0, "rgba(0,0,0,0)"); vig.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = vig; ctx.fillRect(0, 0, W, H);
  }

  function ensureAudioGraph() {
    // Some browsers deliver a fresh AudioContext already suspended (or
    // re-suspend it after the tab was backgrounded) even when this runs
    // inside a user click, so resume it every call — cheap no-op if it's
    // already running. This keeps the beat-reactive visuals working
    // reliably instead of silently going flat after a mode switch.
    if (sourceConnected) { if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {}); return true; }
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      sourceConnected = true;
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    } catch (err) {
      // Never let a failed audio tap break the toggle itself — Rage Mode's
      // visuals still run fine without live frequency data (readBass()
      // falls back to a gentle synthetic pulse), so this is a soft failure.
      console.warn("Rage Mode: couldn't tap audio for analysis, continuing without beat-reactivity", err);
      sourceConnected = false;
    }
    return sourceConnected;
  }

  function readBass() {
    if (!analyser) { bassAvg = active ? Math.max(0.06, bassAvg * 0.9) : 0; return; }
    analyser.getByteFrequencyData(dataArray);
    let sum = 0; const bins = 5;
    for (let i = 0; i < bins; i++) sum += dataArray[i];
    bassAvg = (sum / bins) / 255; // 0..1
  }

  function triggerFlash() {
    const flashEl = document.getElementById("rageFlash");
    if (!flashEl) return;
    flashEl.style.transition = "none"; flashEl.style.opacity = "0.85";
    requestAnimationFrame(() => { flashEl.style.transition = "opacity .35s ease"; flashEl.style.opacity = "0"; });
  }
  function shakeScreen(amount) {
    const appEl = document.getElementById("app");
    if (!appEl) return;
    const dx = (Math.random() - 0.5) * amount, dy = (Math.random() - 0.5) * amount;
    appEl.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    clearTimeout(shakeScreen._t);
    shakeScreen._t = setTimeout(() => { appEl.style.transform = ""; }, 90);
  }

  function startChant() {
    clearInterval(rageLineTimer);
    const el = document.getElementById("ravensLine");
    rageLineTimer = setInterval(() => {
      if (!el) return;
      rageLineIdx = (rageLineIdx + 1) % RAGE_LINES.length;
      el.textContent = RAGE_LINES[rageLineIdx];
    }, 2400);
  }
  function stopChant() { clearInterval(rageLineTimer); }

  /** "Corrupted transmission" glitch — plays once, only when Rage Mode is
   *  switched ON by the person (never on a cold app load for everyone).
   *  Pure CSS handles the tear/channel-split animation; this just drives
   *  the noise layer and removes the overlay when it's done. */
  function playGlitchIntro() {
    const overlay = document.getElementById("rageGlitchIntro");
    const noiseCanvas = document.getElementById("rageGlitchNoise");
    if (!overlay || !noiseCanvas) return;
    const nctx = noiseCanvas.getContext("2d");
    noiseCanvas.width = window.innerWidth; noiseCanvas.height = window.innerHeight;
    let noiseFrames = 0;
    const noiseRaf = setInterval(() => {
      const w = noiseCanvas.width, h = noiseCanvas.height;
      const imgData = nctx.createImageData(w, h);
      for (let i = 0; i < imgData.data.length; i += 4) {
        const v = Math.random() < 0.06 ? 255 : Math.random() * 40;
        const tint = Math.random() < 0.1;
        imgData.data[i] = v; imgData.data[i + 1] = tint ? v * 0.3 : v; imgData.data[i + 2] = tint ? v * 0.3 : v;
        imgData.data[i + 3] = Math.random() < 0.5 ? 255 : 0;
      }
      nctx.putImageData(imgData, 0, 0);
      noiseFrames++;
    }, 45);
    overlay.classList.add("playing");
    setTimeout(() => { clearInterval(noiseRaf); overlay.classList.remove("playing"); }, 1800);
  }

  function setActive(on) {
    active = on;
    document.documentElement.classList.toggle("rage-active", on);
    if (on) {
      if (!embers.length) embers = Array.from({ length: EMBER_COUNT }, () => { const e = {}; spawnEmber(e); e.life = Math.random() * e.max; return e; });
      if (!denInitialized) initDenScene();
      startChant();
    } else {
      const appEl = document.getElementById("app"); if (appEl) appEl.style.transform = "";
      stopChant();
      updateRavensLine();
    }
  }
  /** Toggles whether the canvas paints its own opaque Demon's Den floor
   *  or washes translucently so a chosen #rageBgLayer image shows through
   *  underneath it — called from Settings whenever the Rage Background
   *  picker changes, and on load. */
  function setBackgroundActive(on) { bgActive = on; }
  /** Switches the ambience effect — "smoke" (default, dense billowing
   *  smoke) or "none" (effect off entirely). No flame/fire or dripping
   *  effect exists. Called from Settings → Ambience. */
  function setDripType(type) {
    dripType = type;
    if (type === "smoke") initSmoke(true);
    else if (!smokeParticles.length) initSmoke(false);
  }
  function init(canvasEl) {
    canvas = canvasEl; ctx = canvas.getContext("2d"); resize();
    window.addEventListener("resize", () => { resize(); if (denInitialized) initDenScene(); });
    if (!raf) frame();
  }

  return { init, setActive, setBackgroundActive, setDripType, ensureAudioGraph, playGlitchIntro, get active() { return active; } };
})();
RageMode.init(document.getElementById("rageCanvas"));

/* ---------------------------------------------------------------------
   Storage access — File System Access API with graceful fallback
   --------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   Connecting overlay — hourglass + cycling status while we request
   access and scan the folder. Purely cosmetic, but keeps the person
   informed that something real is happening in the background.
   --------------------------------------------------------------------- */
const connectingEls = {
  card: document.getElementById("connectingCard"),
  onboardCard: document.getElementById("onboardingCard"),
  status: document.getElementById("connectingStatus"),
  sub: document.getElementById("connectingSub"),
};
let connectingCycleTimer = null;
const CONNECT_FLAVOR = [
  ["Requesting access…", "Waiting on your permission prompt."],
  ["Opening the archive…", "This stays on your device."],
  ["Ravens dispatched…", "Searching every folder and subfolder."],
];
function showConnecting(immediateStatus) {
  els.onboarding.classList.remove("hidden"); // works for first run AND for rescans triggered from inside the app
  connectingEls.onboardCard.classList.add("hidden");
  connectingEls.card.classList.remove("hidden");
  let i = 0;
  setConnectingStatus(immediateStatus || CONNECT_FLAVOR[0][0], CONNECT_FLAVOR[0][1]);
  clearInterval(connectingCycleTimer);
  connectingCycleTimer = setInterval(() => {
    i = (i + 1) % CONNECT_FLAVOR.length;
    if (!connectingEls.card._locked) setConnectingStatus(CONNECT_FLAVOR[i][0], CONNECT_FLAVOR[i][1]);
  }, 1800);
}
function setConnectingStatus(status, sub, lock) {
  connectingEls.status.style.opacity = 0;
  setTimeout(() => { connectingEls.status.textContent = status; connectingEls.status.style.opacity = 1; }, 120);
  if (sub !== undefined) connectingEls.sub.textContent = sub;
  connectingEls.card._locked = !!lock;
}
function hideConnecting() {
  clearInterval(connectingCycleTimer);
  connectingEls.card.classList.add("hidden");
  connectingEls.onboardCard.classList.remove("hidden");
}
/** Used when a folder request is cancelled/fails — return to wherever the user actually was. */
function cancelConnecting() {
  clearInterval(connectingCycleTimer);
  connectingEls.card.classList.add("hidden");
  connectingEls.onboardCard.classList.remove("hidden");
  if (state.songs.length) els.onboarding.classList.add("hidden"); // already had a library — go back to it
}
function setStorageBusy(busy) {
  const dot = document.getElementById("storageDot");
  if (dot) dot.classList.toggle("busy", busy);
}

function fsApiSupported() {
  return typeof window.showDirectoryPicker === "function";
}

async function requestFolderAccess() {
  if (fsApiSupported()) {
    showConnecting();
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      await idbSet("kv", "dirHandle", handle);
      state.usingFSApi = true;
      setConnectingStatus("Access granted — scanning…", "Reading your folder structure.");
      await scanDirectoryHandle(handle);
    } catch (err) {
      cancelConnecting();
      if (err && err.name === "AbortError") return;
      console.error(err);
      toast("Couldn't access that folder. Try again.");
    }
  } else {
    els.folderFallbackInput.click();
  }
}

els.folderFallbackInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []).filter(f => AUDIO_EXT.test(f.name));
  if (!files.length) { toast("No audio files found in that folder."); return; }
  showConnecting("Reading your folder…", "This stays on your device.");
  state.usingFSApi = false;
  await idbSet("kv", "usedFallback", true);
  await ingestFileList(files);
});

async function verifyPermission(handle, requestIfNeeded) {
  const opts = { mode: "read" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if (requestIfNeeded && (await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

async function tryResumeFolder() {
  try {
    const handle = await idbGet("kv", "dirHandle");
    if (handle) {
      const granted = await verifyPermission(handle, false);
      if (granted) {
        showConnecting("Welcome back…", "Resuming access to your saved folder.");
        state.usingFSApi = true;
        await scanDirectoryHandle(handle);
        return true;
      } else {
        // Show a resume button instead of auto-onboarding blank state
        showResumePrompt(handle);
        return "needs-permission";
      }
    }
  } catch (err) {
    console.warn("resume failed", err);
  }
  return false;
}

function showResumePrompt(handle) {
  els.grantAccessBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>
    Resume Access to Your Music`;
  els.grantAccessBtn.onclick = async () => {
    showConnecting("Requesting permission…", "One tap to reconnect your folder.");
    const granted = await verifyPermission(handle, true);
    if (granted) {
      setConnectingStatus("Access granted — scanning…", "Reading your folder structure.");
      state.usingFSApi = true;
      await scanDirectoryHandle(handle);
    } else {
      cancelConnecting();
      toast("Access wasn't granted.");
    }
  };
}

/* Recursively walk a FileSystemDirectoryHandle */
async function scanDirectoryHandle(dirHandle, relPath = "") {
  setConnectingStatus("Scanning your library…", "Searching every folder and subfolder.", true);
  els.storageLabel.textContent = "Scanning your library…";
  setStorageBusy(true);
  const found = [];
  async function walk(handle, path) {
    for await (const [name, entry] of handle.entries()) {
      const p = path ? `${path}/${name}` : name;
      if (entry.kind === "directory") {
        await walk(entry, p);
      } else if (entry.kind === "file" && AUDIO_EXT.test(name)) {
        found.push({ handle: entry, path: p, folder: path || "Library Root" });
        if (found.length % 15 === 0) setConnectingStatus(`Found ${found.length} songs so far…`, "Still searching your folders.", true);
      }
    }
  }
  try {
    await walk(dirHandle, "");
  } catch (err) {
    console.error(err);
    toast("Scan interrupted — some files may be missing.");
  }
  setConnectingStatus(`Cataloguing ${found.length} song${found.length === 1 ? "" : "s"}…`, "Almost there.", true);
  await buildLibraryFromEntries(found, true);
}

async function ingestFileList(fileList) {
  const found = fileList.map((f) => {
    const rel = f.webkitRelativePath || f.name;
    const parts = rel.split("/");
    parts.pop();
    return { handle: f, path: rel, folder: parts.join("/") || "Library Root" };
  });
  setConnectingStatus(`Cataloguing ${found.length} song${found.length === 1 ? "" : "s"}…`, "Almost there.", true);
  await buildLibraryFromEntries(found, false);
}

/* Build song metadata list from raw file entries (handle=File or FileSystemFileHandle) */
async function buildLibraryFromEntries(entries, isFsApi) {
  els.storageLabel.textContent = `Reading ${entries.length} file${entries.length === 1 ? "" : "s"}…`;
  const songs = [];
  const folderMap = new Map();
  state.fileRefs.clear();

  for (const e of entries) {
    const id = hashStr(e.path);
    const filename = e.path.split("/").pop();
    const { artist, title } = titleCaseFromFilename(filename);
    const album = e.folder.split("/").pop() || "Unknown Album";
    const song = {
      id,
      title: title || filename,
      artist: artist || "Unknown Artist",
      album,
      folder: e.folder,
      ext: (filename.split(".").pop() || "").toLowerCase(),
      size: 0,
      duration: 0,
      year: 0,
      dateAdded: Date.now(),
    };
    songs.push(song);
    state.fileRefs.set(id, e.handle);
    if (!folderMap.has(e.folder)) folderMap.set(e.folder, []);
    folderMap.get(e.folder).push(id);
  }

  state.songs = songs;
  state.foldersMap = folderMap;
  await idbSet("kv", "songIndex", songs.map(s => ({ id: s.id, title: s.title, artist: s.artist, album: s.album, folder: s.folder })));

  finishOnboarding();
  render();

  // Load size + duration progressively in the background, re-rendering as it fills in
  loadMetadataProgressively(entries, isFsApi);
}

async function loadMetadataProgressively(entries, isFsApi) {
  let done = 0;
  const CONCURRENCY = 6;
  let idx = 0;
  setStorageBusy(true);
  async function worker() {
    while (idx < entries.length) {
      const myIdx = idx++;
      const e = entries[myIdx];
      const id = hashStr(e.path);
      try {
        const file = isFsApi ? await e.handle.getFile() : e.handle;
        const song = state.songs.find(s => s.id === id);
        if (song) {
          song.size = file.size;
          song.dateAdded = file.lastModified || Date.now();
          await loadDuration(file, song);
          await loadEmbeddedArt(file, song);
        }
      } catch (err) { /* skip unreadable file */ }
      done++;
      if (done % 12 === 0 || done === entries.length) {
        els.storageLabel.textContent = done < entries.length
          ? `Reading ${done}/${entries.length}…`
          : `${state.songs.length} song${state.songs.length === 1 ? "" : "s"} in your library`;
        render();
      }
    }
  }
  els.storageLabel.textContent = `${state.songs.length} songs found — loading details…`;
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  els.storageLabel.textContent = `${state.songs.length} song${state.songs.length === 1 ? "" : "s"} in your library`;
  setStorageBusy(false);
  updateNavCounts();
}

function loadDuration(file, song) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const cleanup = () => { URL.revokeObjectURL(url); resolve(); };
    a.addEventListener("loadedmetadata", () => { song.duration = a.duration || 0; cleanup(); }, { once: true });
    a.addEventListener("error", cleanup, { once: true });
    setTimeout(cleanup, 4000);
    a.src = url;
  });
}

/** Reads the song file's own embedded cover art (ID3v2/FLAC/MP4 tag) the
 *  first time we ever see this song, caches it in IndexedDB so it's
 *  instant on every later load, and — if this song happens to be the
 *  one currently open in the mini/full player — refreshes that art
 *  immediately instead of waiting for the next periodic re-render. Skips
 *  the work entirely for songs that already have a custom photo (which
 *  always wins anyway) or that we've already extracted art for. */
async function loadEmbeddedArt(file, song) {
  if (state.customArt.has(song.id) || state.embeddedArt.has(song.id)) return;
  try {
    const dataUrl = await window.VV.getEmbeddedArtForFile(file);
    if (!dataUrl) return;
    state.embeddedArt.set(song.id, dataUrl);
    idbSet("embeddedArt", song.id, dataUrl); // fire-and-forget cache write
    if (state.queue[state.queueIndex] === song.id) { syncNowPlayingUI(song); updateMediaSession(song); }
  } catch { /* no embedded art — falls back to generated art as before */ }
}

function finishOnboarding() {
  hideConnecting();
  els.onboarding.classList.add("hidden");
  els.appBody.classList.remove("hidden");
  els.miniPlayer.classList.remove("hidden");
  if (window.innerWidth < 900) els.tabbar.classList.remove("hidden");
}

/* ---------------------------------------------------------------------
   Persisted user data: playlists / favorites / play counts / settings
   --------------------------------------------------------------------- */
async function loadUserData() {
  const [playlists, favKeys, pcEntries, settings, recent, customBgBlob, customArtEntries, embeddedArtEntries, customBgVideoBlob] = await Promise.all([
    idbGetAll("playlists"),
    idbGetAllKeys("favorites"),
    (async () => {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction("playCounts", "readonly");
        const store = tx.objectStore("playCounts");
        const out = [];
        const req = store.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) { out.push([cur.key, cur.value]); cur.continue(); } else resolve(out);
        };
        req.onerror = () => resolve(out);
      });
    })(),
    idbGet("kv", "settings"),
    idbGet("kv", "recentlyPlayed"),
    idbGet("kv", "customBgImage"),
    idbGetAllEntries("customArt"),
    idbGetAllEntries("embeddedArt"),
    idbGet("kv", "customBgVideo"),
  ]);
  state.playlists = playlists || [];
  state.favorites = new Set(favKeys || []);
  state.playCounts = new Map(pcEntries || []);
  state.recentlyPlayed = recent || [];
  state.customArt = new Map(customArtEntries || []);
  state.embeddedArt = new Map(embeddedArtEntries || []);
  // Re-derive an object URL for the uploaded background photo, if any —
  // object URLs don't survive a page reload, but the Blob behind it does.
  if (customBgBlob) {
    if (customBgObjectUrl) URL.revokeObjectURL(customBgObjectUrl);
    customBgObjectUrl = URL.createObjectURL(customBgBlob);
  }
  // Same idea for a user-uploaded custom video background.
  if (customBgVideoBlob) {
    if (customBgVideoObjectUrl) URL.revokeObjectURL(customBgVideoObjectUrl);
    customBgVideoObjectUrl = URL.createObjectURL(customBgVideoBlob);
  }
  if (settings) state.settings = { ...state.settings, ...settings };
  applySettingsToUI();
}

async function saveSettings() { await idbSet("kv", "settings", state.settings); }

/* Default system playlist: Recently Played — records a play event every
   time a song starts, most-recent-first, capped at RECENT_CAP entries. */
async function recordRecentlyPlayed(songId) {
  state.recentlyPlayed = state.recentlyPlayed.filter(e => e.id !== songId);
  state.recentlyPlayed.unshift({ id: songId, playedAt: Date.now() });
  if (state.recentlyPlayed.length > RECENT_CAP) state.recentlyPlayed.length = RECENT_CAP;
  await idbSet("kv", "recentlyPlayed", state.recentlyPlayed);
  if (state.currentView === "recent") render();
  else updateNavCounts();
}
function recentlyPlayedSongs() {
  return state.recentlyPlayed.map(e => state.songs.find(s => s.id === e.id)).filter(Boolean);
}
async function removeFromRecentlyPlayed(songIds) {
  const remove = new Set(songIds);
  state.recentlyPlayed = state.recentlyPlayed.filter(e => !remove.has(e.id));
  await idbSet("kv", "recentlyPlayed", state.recentlyPlayed);
}
async function clearRecentlyPlayed() {
  state.recentlyPlayed = [];
  await idbSet("kv", "recentlyPlayed", []);
  render();
}

async function toggleFavorite(songId) {
  if (state.favorites.has(songId)) {
    state.favorites.delete(songId);
    await idbDelete("favorites", songId);
  } else {
    state.favorites.add(songId);
    await idbSet("favorites", songId, true);
  }
  render();
  syncPlayerFavIcon();
}
async function removeFavorites(songIds) {
  await Promise.all(songIds.map(id => { state.favorites.delete(id); return idbDelete("favorites", id); }));
  render();
}

async function bumpPlayCount(songId) {
  const n = (state.playCounts.get(songId) || 0) + 1;
  state.playCounts.set(songId, n);
  await idbSet("playCounts", songId, n);
}

async function createPlaylist(name) {
  const pl = { id: "pl_" + Date.now().toString(36), name: name.trim() || "Untitled Playlist", songIds: [] };
  state.playlists.push(pl);
  await idbPut("playlists", pl);
  render();
  return pl;
}
async function addSongToPlaylist(playlistId, songId) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  if (pl.songIds.includes(songId)) { toast("Already in that playlist"); return; }
  pl.songIds.push(songId);
  await idbPut("playlists", pl);
  toast(`Added to "${pl.name}"`);
  render();
}
async function removeSongFromPlaylist(playlistId, songId) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  pl.songIds = pl.songIds.filter(id => id !== songId);
  await idbPut("playlists", pl);
  render();
}
async function deletePlaylist(playlistId) {
  state.playlists = state.playlists.filter(p => p.id !== playlistId);
  await idbDelete("playlists", playlistId);
  navigateTo("playlists");
}
async function renamePlaylist(playlistId, newName) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  pl.name = newName.trim() || pl.name;
  await idbPut("playlists", pl);
  render();
}
async function removeSongsFromPlaylist(playlistId, songIds) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  const remove = new Set(songIds);
  pl.songIds = pl.songIds.filter(id => !remove.has(id));
  await idbPut("playlists", pl);
  render();
}

/* ---------------------------------------------------------------------
   Sorting / filtering
   --------------------------------------------------------------------- */
function sortSongs(list) {
  const s = state.sort;
  const arr = [...list];
  arr.sort((a, b) => {
    switch (s) {
      case "artist": return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
      case "album": return a.album.localeCompare(b.album) || a.title.localeCompare(b.title);
      case "duration": return b.duration - a.duration;
      case "size": return b.size - a.size;
      case "year": return (b.year || 0) - (a.year || 0);
      case "dateAdded": return b.dateAdded - a.dateAdded;
      case "playCount": return (state.playCounts.get(b.id) || 0) - (state.playCounts.get(a.id) || 0);
      default: return a.title.localeCompare(b.title);
    }
  });
  return arr;
}
function filterSongs(list) {
  const q = state.search.trim().toLowerCase();
  if (!q) return list;
  return list.filter(s =>
    s.title.toLowerCase().includes(q) ||
    s.artist.toLowerCase().includes(q) ||
    s.album.toLowerCase().includes(q)
  );
}
function visibleSongs(list) { return sortSongs(filterSongs(list)); }

/* ---------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------- */
function songRowHtml(song, index, opts = {}) {
  const isPlaying = state.queue[state.queueIndex] === song.id;
  const fav = state.favorites.has(song.id);
  const selecting = opts.selectable && state.selectMode;
  const selected = selecting && state.selectedIds.has(song.id);
  return `
  <div class="song-row ${isPlaying ? "playing" : ""} ${selected ? "selected" : ""}" data-id="${song.id}" tabindex="0" role="button">
    ${selecting ? `<span class="row-check" data-action="toggle-select" data-id="${song.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12l5 5L20 6"/></svg></span>` : ""}
    ${opts.showIndex ? `<span class="index">${index + 1}</span>` : ""}
    <div class="art">${artHtml(song)}</div>
    <div class="meta">
      <div class="title">${escapeHtml(song.title)}</div>
      <div class="sub">${escapeHtml(song.artist)} ${song.album ? "· " + escapeHtml(song.album) : ""}</div>
    </div>
    <span class="dur">${song.duration ? fmtTime(song.duration) : ""}</span>
    ${selecting ? "" : `<div class="row-actions">
      <button class="fav-btn ${fav ? "active" : ""}" data-action="fav" data-id="${song.id}" title="Favorite">
        <svg viewBox="0 0 24 24" fill="${fav ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z"/></svg>
      </button>
      <button class="queue-btn" data-action="queue" data-id="${song.id}" title="Play next">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h9M4 12h9M4 18h9M17 6v12m0 0l-3-3m3 3l3-3"/></svg>
      </button>
      <button class="more-btn" data-action="more" data-id="${song.id}" title="Add to playlist">
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
      </button>
    </div>`}
  </div>`;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function emptyStateHtml(title, sub, iconPath) {
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">${iconPath}</svg>
    <div class="t">${title}</div>
    <div class="s">${sub}</div>
  </div>`;
}

function renderSongsView() {
  const list = visibleSongs(state.songs);
  els.viewSongs.innerHTML = list.length
    ? `<div class="section-label">${list.length} Song${list.length === 1 ? "" : "s"}</div>` +
      list.map((s, i) => songRowHtml(s, i)).join("")
    : emptyStateHtml("No songs yet", "Grant access to a folder with audio files to build your library.",
        '<path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/>');
}

/* ---------------------------------------------------------------------
   Multi-select toolbar — shared by Favorites, Recently Played, and
   individual Playlists, since "select all + remove" means something
   slightly different in each (un-favorite / forget / remove-from-list).
   --------------------------------------------------------------------- */
function selectToolbarHtml(totalCount) {
  const n = state.selectedIds.size;
  if (!state.selectMode) return "";
  return `
  <div class="select-toolbar">
    <button data-action="select-all">${n === totalCount && totalCount > 0 ? "Deselect All" : "Select All"}</button>
    <span class="count">${n} selected</span>
    <button class="remove-selected-btn" data-action="remove-selected" ${n === 0 ? "disabled" : ""}>Remove</button>
    <button data-action="cancel-select">Cancel</button>
  </div>`;
}
function selectToggleBtnHtml() {
  return `<button class="select-toggle-btn ${state.selectMode ? "active" : ""}" data-action="toggle-select-mode" title="Select songs">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12l5 5L20 6"/></svg> Select
  </button>`;
}

function renderFavoritesView() {
  const list = visibleSongs(state.songs.filter(s => state.favorites.has(s.id)));
  els.viewFavorites.innerHTML = list.length
    ? `<div class="section-label">${list.length} Favorite${list.length === 1 ? "" : "s"}${selectToggleBtnHtml()}</div>` +
      selectToolbarHtml(list.length) +
      list.map((s, i) => songRowHtml(s, i, { selectable: true })).join("")
    : emptyStateHtml("No favorites yet", "Tap the heart on any song to keep it close.",
        '<path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z"/>');
}

function renderRecentView() {
  const list = visibleSongs(recentlyPlayedSongs());
  els.viewRecent.innerHTML = list.length
    ? `<div class="section-label">${list.length} Recently Played${selectToggleBtnHtml()}
        <button class="icon-btn" style="margin-left:6px;width:auto;height:auto;padding:5px 10px;border-radius:999px;font-size:10.5px;" data-action="clear-recent" title="Clear history">Clear</button>
      </div>` +
      selectToolbarHtml(list.length) +
      list.map((s, i) => songRowHtml(s, i, { selectable: true })).join("")
    : emptyStateHtml("Nothing played yet", "Songs you play will show up here automatically.",
        '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>');
}

function renderFoldersView() {
  const folders = Array.from(state.foldersMap.entries());
  if (!folders.length) {
    els.viewFolders.innerHTML = emptyStateHtml("No folders found", "Your music folder will appear here once scanned.",
      '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>');
    return;
  }
  els.viewFolders.innerHTML = `<div class="card-grid">${folders.map(([path, ids]) => `
    <div class="folder-card" data-folder="${encodeURIComponent(path)}">
      <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg></div>
      <div class="name">${escapeHtml(path.split("/").pop() || path)}</div>
      <div class="n">${ids.length} song${ids.length === 1 ? "" : "s"}</div>
    </div>`).join("")}</div>`;
}

function renderFolderDetail(folderPath) {
  const ids = state.foldersMap.get(folderPath) || [];
  const list = visibleSongs(state.songs.filter(s => ids.includes(s.id)));
  els.viewFolderDetail.innerHTML = `
    <button class="btn-secondary" style="width:auto;display:inline-flex;margin-bottom:16px;" data-action="back-folders">← All Folders</button>
    <div class="section-label">${escapeHtml(folderPath.split("/").pop() || folderPath)}</div>
    ${list.map((s, i) => songRowHtml(s, i)).join("") || emptyStateHtml("Empty folder", "", '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>')}
  `;
}

function renderPlaylistsView() {
  const recentCount = state.recentlyPlayed.length;
  els.viewPlaylists.innerHTML = `<div class="card-grid">
    <div class="playlist-card new-playlist-card" id="newPlaylistCard">
      <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 5v14M5 12h14"/></svg></div>
      <div class="name">New Playlist</div>
    </div>
    <div class="playlist-card recent-card" data-view-jump="recent">
      <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg></div>
      <div class="name">Recently Played</div>
      <div class="n">${recentCount} song${recentCount === 1 ? "" : "s"}</div>
    </div>
    ${state.playlists.map(pl => `
    <div class="playlist-card" data-playlist="${pl.id}">
      <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h16M4 12h10M4 18h10M18 15v6m3-3h-6"/></svg></div>
      <div class="name">${escapeHtml(pl.name)}</div>
      <div class="n">${pl.songIds.length} song${pl.songIds.length === 1 ? "" : "s"}</div>
    </div>`).join("")}
  </div>`;
}

function renderPlaylistDetail(playlistId) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) { navigateTo("playlists"); return; }
  const songs = pl.songIds.map(id => state.songs.find(s => s.id === id)).filter(Boolean);
  const list = visibleSongs(songs);
  els.viewPlaylistDetail.innerHTML = `
    <button class="btn-secondary" style="width:auto;display:inline-flex;margin-bottom:16px;" data-action="back-playlists">← All Playlists</button>
    <div class="section-label">${escapeHtml(pl.name)}
      <button class="playlist-rename-btn" data-action="rename-playlist" data-id="${pl.id}" title="Rename playlist">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
      </button>
      <button class="icon-btn" style="margin-left:2px;" data-action="delete-playlist" data-id="${pl.id}" title="Delete playlist">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg>
      </button>
      ${list.length ? selectToggleBtnHtml() : ""}
    </div>
    ${selectToolbarHtml(list.length)}
    ${list.length ? list.map((s, i) => playlistRowHtml(s, i, pl.id)).join("") :
      emptyStateHtml("Playlist is empty", "Use the ⋮ menu on any song to add it here.",
      '<path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/>')}
  `;
}
function playlistRowHtml(song, index, playlistId) {
  const isPlaying = state.queue[state.queueIndex] === song.id;
  const selecting = state.selectMode;
  const selected = selecting && state.selectedIds.has(song.id);
  return `
  <div class="song-row ${isPlaying ? "playing" : ""} ${selected ? "selected" : ""}" data-id="${song.id}" data-playlist-ctx="${playlistId}" tabindex="0" role="button">
    ${selecting ? `<span class="row-check" data-action="toggle-select" data-id="${song.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12l5 5L20 6"/></svg></span>` : ""}
    <div class="art">${artHtml(song)}</div>
    <div class="meta">
      <div class="title">${escapeHtml(song.title)}</div>
      <div class="sub">${escapeHtml(song.artist)}</div>
    </div>
    <span class="dur">${song.duration ? fmtTime(song.duration) : ""}</span>
    ${selecting ? "" : `<div class="row-actions">
      <button class="queue-btn" data-action="queue" data-id="${song.id}" title="Play next">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h9M4 12h9M4 18h9M17 6v12m0 0l-3-3m3 3l3-3"/></svg>
      </button>
      <button class="more-btn" data-action="remove-from-playlist" data-id="${song.id}" data-playlist="${playlistId}" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`}
  </div>`;
}

function updateNavCounts() {
  $("#navSongsCount").textContent = state.songs.length || "";
  $("#navPlaylistsCount").textContent = state.playlists.length || "";
  $("#navFoldersCount").textContent = state.foldersMap.size || "";
  $("#navFavoritesCount").textContent = state.favorites.size || "";
  $("#navRecentCount").textContent = state.recentlyPlayed.length || "";
  updateRavensLine();
}

function render() {
  updateNavCounts();
  const v = state.currentView;
  [els.viewSongs, els.viewPlaylists, els.viewPlaylistDetail, els.viewFolders, els.viewFolderDetail, els.viewFavorites, els.viewRecent]
    .forEach(el => el.classList.add("hidden"));

  if (v === "songs") { els.viewSongs.classList.remove("hidden"); renderSongsView(); els.viewTitle.textContent = "Library"; }
  else if (v === "playlists") { els.viewPlaylists.classList.remove("hidden"); renderPlaylistsView(); els.viewTitle.textContent = "Playlists"; }
  else if (v === "playlist-detail") { els.viewPlaylistDetail.classList.remove("hidden"); renderPlaylistDetail(state.currentPlaylist); els.viewTitle.textContent = "Playlist"; }
  else if (v === "folders") { els.viewFolders.classList.remove("hidden"); renderFoldersView(); els.viewTitle.textContent = "Folders"; }
  else if (v === "folder-detail") { els.viewFolderDetail.classList.remove("hidden"); renderFolderDetail(state.currentFolder); els.viewTitle.textContent = "Folder"; }
  else if (v === "favorites") { els.viewFavorites.classList.remove("hidden"); renderFavoritesView(); els.viewTitle.textContent = "Favorites"; }
  else if (v === "recent") { els.viewRecent.classList.remove("hidden"); renderRecentView(); els.viewTitle.textContent = "Recently Played"; }

  els.contentScroll.scrollTop = render._lastView === v ? els.contentScroll.scrollTop : 0;
  render._lastView = v;
}

function navigateTo(view) {
  state.currentView = view;
  state.selectMode = false;
  state.selectedIds.clear();
  els.navItems.forEach(b => b.classList.toggle("active", b.dataset.view === view));
  els.tabbarBtns.forEach(b => b.classList.toggle("active", b.dataset.view === view));
  render();
}

/* ---------------------------------------------------------------------
   Playback engine
   --------------------------------------------------------------------- */
async function getFileForSong(songId) {
  const ref = state.fileRefs.get(songId);
  if (!ref) return null;
  if (state.usingFSApi && ref.getFile) return await ref.getFile();
  return ref; // already a File
}

async function playSongId(songId, queueList) {
  if (queueList) {
    state.queue = queueList;
    state.queueIndex = queueList.indexOf(songId);
  } else if (!state.queue.includes(songId)) {
    state.queue = [songId];
    state.queueIndex = 0;
  } else {
    state.queueIndex = state.queue.indexOf(songId);
  }
  await loadAndPlayCurrent();
}

/** "Add up next" — inserts right after the currently playing track, or
 *  starts a fresh queue with it if nothing is playing yet. */
function addToQueueNext(songId) {
  const song = state.songs.find(s => s.id === songId);
  if (!song) return;
  if (!state.queue.length) { playSongId(songId); return; }
  // If it's already queued somewhere, relocate it rather than duplicate it.
  const existingIndex = state.queue.indexOf(songId);
  if (existingIndex !== -1) {
    state.queue.splice(existingIndex, 1);
    if (existingIndex < state.queueIndex) state.queueIndex--; // removing an earlier item shifts the current index down
  }
  state.queue.splice(state.queueIndex + 1, 0, songId);
  toast(`Up next: ${song.title}`);
  if (els.queueSheet.classList.contains("open")) renderQueueSheet();
}

async function loadAndPlayCurrent() {
  const songId = state.queue[state.queueIndex];
  const song = state.songs.find(s => s.id === songId);
  if (!song) return;
  const file = await getFileForSong(songId);
  if (!file) { toast("Couldn't read that file."); return; }
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  const myLoadToken = ++audioLoadToken; // guards against a stale play()/error firing after a newer track has already started loading
  audio.src = state.objectUrl;
  RageMode.ensureAudioGraph();
  try {
    await audio.play();
    if (myLoadToken !== audioLoadToken) return;
    state.isPlaying = true;
  } catch (err) {
    if (myLoadToken !== audioLoadToken) return;
    state.isPlaying = false;
    handleUnplayableSong(song, err);
    return;
  }
  bumpPlayCount(songId);
  bumpMonthStat(song);
  recordRecentlyPlayed(songId);
  window.VV.BookTransition.play();
  syncNowPlayingUI(song);
  updateMediaSession(song);
  render();
}
let audioLoadToken = 0;
/** Broadening which extensions count as "a song" (see AUDIO_EXT) means
 *  some files that get found and added still won't have a decoder the
 *  browser/OS actually supports — e.g. WMA, MIDI, or an unusual codec
 *  inside a common container. Rather than leaving playback silently
 *  stuck on a track that will never start, let the person know and move
 *  on automatically instead of stalling the queue. */
function handleUnplayableSong(song) {
  toast(`Can't play "${song.title}" — unsupported audio format on this device.`, 3200);
  if (state.queue.length > 1) setTimeout(() => nextSong(true), 500);
}

/* ---------------------------------------------------------------------
   Monthly/yearly listening stats — feeds the Recap page
   --------------------------------------------------------------------- */
function monthKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
async function bumpMonthStat(song) {
  const key = monthKey();
  const rec = (await idbGet("monthStats", key)) || { seconds: 0, plays: {}, meta: {} };
  rec.plays[song.id] = (rec.plays[song.id] || 0) + 1;
  rec.meta[song.id] = { title: song.title, artist: song.artist, album: song.album };
  await idbSet("monthStats", key, rec);
}
let lastStatFlush = 0;
audio.addEventListener("timeupdate", () => {
  if (!state.isPlaying) return;
  const now = Date.now();
  if (now - lastStatFlush < 5000) return; // flush every ~5s of real playback
  lastStatFlush = now;
  const key = monthKey();
  idbGet("monthStats", key).then(rec => {
    rec = rec || { seconds: 0, plays: {}, meta: {} };
    rec.seconds += 5;
    idbSet("monthStats", key, rec);
  });
});

function syncNowPlayingUI(song) {
  const art = artHtml(song);
  els.miniArt.innerHTML = art;
  els.miniTitle.textContent = song.title;
  els.miniArtist.textContent = song.artist;
  els.playerArt.innerHTML = art;
  els.playerTitle.textContent = song.title;
  els.playerArtist.textContent = song.artist;
  els.playerSourceLabel.textContent = song.album || "Now Playing";
  syncPlayerFavIcon();
  syncPlayerArtButtons(song);
  setPlayIcon(state.isPlaying);
}
/** Shows the "reset to default art" button only when the currently
 *  playing song has a custom photo uploaded; the edit (pencil) button
 *  is always visible so a photo can be added or replaced any time. */
function syncPlayerArtButtons(song) {
  if (!els.resetArtBtn) return;
  els.resetArtBtn.classList.toggle("hidden", !state.customArt.has(song.id));
}
function syncPlayerFavIcon() {
  const songId = state.queue[state.queueIndex];
  const fav = state.favorites.has(songId);
  els.favBtn.classList.toggle("active", fav);
  els.favBtn.querySelector("svg").setAttribute("fill", fav ? "currentColor" : "none");
  els.favBtn.style.color = fav ? "var(--accent2)" : "";
}
function setPlayIcon(playing) {
  const pathPlay = '<path d="M8 5v14l11-7z"/>';
  const pathPause = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
  els.playIcon.innerHTML = playing ? pathPause : pathPlay;
  els.miniPlayIcon.innerHTML = playing ? pathPause : pathPlay;
}

function togglePlay() {
  if (!audio.src) return;
  RageMode.ensureAudioGraph();
  if (audio.paused) { audio.play().catch(()=>{}); state.isPlaying = true; }
  else { audio.pause(); state.isPlaying = false; }
  setPlayIcon(state.isPlaying);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
}

function nextSong(auto) {
  if (!state.queue.length) return;
  if (state.repeat === "one" && auto) { loadAndPlayCurrent(); return; }
  let next = state.queueIndex + 1;
  if (next >= state.queue.length) {
    if (state.repeat === "all") next = 0;
    else { state.isPlaying = false; setPlayIcon(false); return; }
  }
  state.queueIndex = next;
  loadAndPlayCurrent();
}
function prevSong() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  let prev = state.queueIndex - 1;
  if (prev < 0) prev = state.repeat === "all" ? state.queue.length - 1 : 0;
  state.queueIndex = prev;
  loadAndPlayCurrent();
}
function toggleShuffle() {
  state.shuffle = !state.shuffle;
  els.shuffleBtn.classList.toggle("active", state.shuffle);
  els.shuffleAllBtn.style.color = state.shuffle ? "var(--accent)" : "";
  if (state.shuffle && state.queue.length > 1) {
    const cur = state.queue[state.queueIndex];
    const rest = state.queue.filter((_, i) => i !== state.queueIndex);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    state.queue = [cur, ...rest];
    state.queueIndex = 0;
    renderQueueSheet();
  }
}
function cycleRepeat() {
  state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
  els.repeatBtn.classList.toggle("active", state.repeat !== "off");
  const svg = els.repeatBtn.querySelector("svg");
  svg.innerHTML = state.repeat === "one"
    ? '<path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3"/><text x="12" y="14" font-size="8" text-anchor="middle" fill="currentColor" stroke="none">1</text>'
    : '<path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3"/>';
}

function shufflePlayAll() {
  const list = visibleSongs(state.songs);
  if (!list.length) { toast("No songs to play."); return; }
  const ids = list.map(s => s.id);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  state.shuffle = true;
  els.shuffleBtn.classList.add("active");
  playSongId(ids[0], ids);
  openPlayer();
}

audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  els.seekFill.style.width = pct + "%";
  els.seekHandle.style.left = pct + "%";
  els.miniProgressFill.style.width = pct + "%";
  els.curTime.textContent = fmtTime(audio.currentTime);
  els.totalTime.textContent = fmtTime(audio.duration);
});
audio.addEventListener("ended", () => nextSong(true));
audio.addEventListener("play", () => { state.isPlaying = true; setPlayIcon(true); });
audio.addEventListener("pause", () => { state.isPlaying = false; setPlayIcon(false); });
/** Covers the case where a file's src loads far enough for play() to
 *  resolve but decoding then fails (corrupt file, or a codec the
 *  container claims to hold but this browser can't actually decode) —
 *  same graceful skip-forward as the play()-rejection path above. */
audio.addEventListener("error", () => {
  if (!audio.error) return;
  const song = state.songs.find(s => s.id === state.queue[state.queueIndex]);
  if (song) { state.isPlaying = false; handleUnplayableSong(song); }
});

function seekTo(clientX) {
  const rect = els.seekTrack.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  if (audio.duration) audio.currentTime = pct * audio.duration;
}
let seeking = false;
els.seekTrack.addEventListener("pointerdown", (e) => { seeking = true; seekTo(e.clientX); });
window.addEventListener("pointermove", (e) => { if (seeking) seekTo(e.clientX); });
window.addEventListener("pointerup", () => { seeking = false; });

/* Media Session — lock screen / notification controls */
function updateMediaSession(song) {
  if (!("mediaSession" in navigator)) return;
  const custom = state.customArt.get(song.id) || state.embeddedArt.get(song.id);
  const art = custom || window.VV.generatedArt(song.title + song.artist + song.id, 512);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title, artist: song.artist, album: song.album || "Vvynas Vane",
    artwork: [{ src: art, sizes: "512x512", type: custom ? "image/jpeg" : "image/png" }],
  });
  navigator.mediaSession.setActionHandler("play", togglePlay);
  navigator.mediaSession.setActionHandler("pause", togglePlay);
  navigator.mediaSession.setActionHandler("previoustrack", prevSong);
  navigator.mediaSession.setActionHandler("nexttrack", () => nextSong(false));
}

/* ---------------------------------------------------------------------
   Full player open/close + queue sheet
   --------------------------------------------------------------------- */
function openPlayer() { els.playerOverlay.classList.add("open"); }
function closePlayer() { els.playerOverlay.classList.remove("open"); }

function queueRowHtml(song, index) {
  const isCurrent = index === state.queueIndex;
  return `
  <div class="song-row ${isCurrent ? "playing" : ""}" data-id="${song.id}" data-queue-index="${index}" tabindex="0" role="button">
    <span class="index">${index + 1}</span>
    <div class="art">${artHtml(song)}</div>
    <div class="meta">
      <div class="title">${escapeHtml(song.title)}</div>
      <div class="sub">${escapeHtml(song.artist)}</div>
    </div>
    <span class="dur">${song.duration ? fmtTime(song.duration) : ""}</span>
    <div class="row-actions">
      <button class="more-btn" data-action="remove-from-queue" data-queue-index="${index}" title="Remove from queue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
  </div>`;
}
function renderQueueSheet() {
  const items = state.queue.map((id, i) => {
    const song = state.songs.find(s => s.id === id);
    return song ? queueRowHtml(song, i) : "";
  }).join("");
  els.queueList.innerHTML = items || emptyStateHtml("Queue is empty", "Play a song to build your queue.", '<path d="M4 6h16M4 12h10M4 18h16"/>');
}
function openQueue() { renderQueueSheet(); els.sheetOverlay.classList.add("open"); els.queueSheet.classList.add("open"); }
function closeQueue() { els.sheetOverlay.classList.remove("open"); els.queueSheet.classList.remove("open"); }

/* ---------------------------------------------------------------------
   Add-to-playlist / new-playlist modals
   --------------------------------------------------------------------- */
function openPlaylistModal(songId) {
  state.addToPlaylistTargetId = songId;
  els.playlistPickList.innerHTML = state.playlists.length
    ? state.playlists.map(pl => `
      <div class="playlist-pick-row" data-playlist="${pl.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h10M4 18h10M18 15v6m3-3h-6"/></svg>
        ${escapeHtml(pl.name)} <span style="margin-left:auto;color:var(--text-muted);font-size:11px;">${pl.songIds.length}</span>
      </div>`).join("")
    : `<p style="color:var(--text-muted);font-size:13px;">No playlists yet — create one below.</p>`;
  els.playlistModalOverlay.classList.add("open");
}
function closePlaylistModal() { els.playlistModalOverlay.classList.remove("open"); }
function openNewPlaylistModal() {
  state.playlistModalMode = "create"; state.renameTargetId = null;
  els.newPlaylistModalTitle.textContent = "New Playlist";
  els.confirmNewPlaylistBtn.textContent = "Create";
  els.newPlaylistModalOverlay.classList.add("open"); els.newPlaylistInput.value = ""; els.newPlaylistInput.focus();
}
function openRenamePlaylistModal(playlistId) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  state.playlistModalMode = "rename"; state.renameTargetId = playlistId;
  els.newPlaylistModalTitle.textContent = "Rename Playlist";
  els.confirmNewPlaylistBtn.textContent = "Save";
  els.newPlaylistModalOverlay.classList.add("open"); els.newPlaylistInput.value = pl.name; els.newPlaylistInput.focus(); els.newPlaylistInput.select();
}
function closeNewPlaylistModal() { els.newPlaylistModalOverlay.classList.remove("open"); }

/* ---------------------------------------------------------------------
   Settings modal + theme
   --------------------------------------------------------------------- */
function applySettingsToUI() {
  document.documentElement.setAttribute("data-theme", state.settings.light ? "light" : "dark");
  els.lightModeSwitch.classList.toggle("on", state.settings.light);
  els.resumeSwitch.classList.toggle("on", state.settings.resume);
  els.rageModeSwitch.classList.toggle("on", state.settings.rageMode);
  window.VV.applyFont(state.settings.fontStyle);
  window.VV.ThemeEngine.setTheme(state.settings.themeId);
  window.VV.setArtStyle(state.settings.artStyle);
  applyAccentColors();
  // Background + ambience effect are applied BEFORE the mode itself goes active,
  // so the very first activation already reflects the saved choices
  // instead of a one-frame flash of stale defaults.
  applyRageBackground();
  applyRageDripType();
  applyThemeVideo();
  applyOverlayStrength();
  RageMode.setActive(state.settings.rageMode);
  renderFontGrid();
  renderThemeGrid();
  renderArtStyleGrid();
  renderRageBgGrid();
  renderRageDripGrid();
  render(); // re-render current view so album art picks up the new style immediately
}
/** Populates the Background Image picker in Settings. The chosen image
 *  now displays in every mode — Light, Dark, and Rage — not just while
 *  Rage Mode is switched on (see #rageBgLayer in style.css). */
function renderRageBgGrid() {
  const grid = document.getElementById("rageBgGrid");
  if (!grid) return;
  const presetTiles = RAGE_BACKGROUNDS.map(b => `
    <div class="rage-bg-option ${state.settings.rageBackground === b.id ? "active" : ""}" data-rage-bg="${b.id}">
      ${b.id === "none"
        ? `<div class="swatch none-swatch">🩸</div>`
        : `<div class="swatch" style="background-image:url('${b.file}')"></div>`}
      <div class="lbl">${b.label}</div>
    </div>`).join("");
  // The uploaded photo, if one is stored, gets its own selectable tile
  // (with a ✕ to remove it) alongside the four presets.
  const customTile = customBgObjectUrl ? `
    <div class="rage-bg-option ${state.settings.rageBackground === "custom" ? "active" : ""}" data-rage-bg="custom">
      <div class="swatch" style="background-image:url('${customBgObjectUrl}')"></div>
      <div class="lbl">My Photo <span class="rage-bg-remove" data-remove-custom-bg title="Remove uploaded photo">✕</span></div>
    </div>` : "";
  // Always-present tile that opens the device file picker — doubles as
  // "Upload Photo" (none stored yet) or "Replace Photo" (one already is).
  const uploadTile = `
    <div class="rage-bg-option rage-bg-upload" data-upload-bg>
      <div class="swatch none-swatch">📁</div>
      <div class="lbl">${customBgObjectUrl ? "Replace Photo" : "Upload Photo"}</div>
    </div>`;
  grid.innerHTML = presetTiles + customTile + uploadTile;
}
/** Applies the currently selected Background Image: sets the CSS layer's
 *  image (now shown in every mode, not just Rage Mode) and tells
 *  RageMode's canvas to wash translucent when Rage Mode is active (so
 *  the image shows through, with the embers/eyes drawn on top) instead
 *  of painting its own opaque Demon's Den floor. */
function applyRageBackground() {
  const layer = document.getElementById("rageBgLayer");
  if (!layer) return;
  // Custom upload takes a separate path since its image lives in an
  // object URL rather than a static filename in RAGE_BACKGROUNDS. If
  // "custom" is selected but there's no image behind it (e.g. it was
  // never re-loaded successfully), fall through to the "none" default.
  if (state.settings.rageBackground === "custom" && customBgObjectUrl) {
    layer.style.backgroundImage = `url("${customBgObjectUrl}")`;
    layer.classList.add("active");
    RageMode.setBackgroundActive(true);
    return;
  }
  const bg = RAGE_BACKGROUNDS.find(b => b.id === state.settings.rageBackground) || RAGE_BACKGROUNDS[0];
  if (bg.id === "none") {
    layer.classList.remove("active");
    layer.style.backgroundImage = "";
    RageMode.setBackgroundActive(false);
  } else {
    layer.style.backgroundImage = `url("${bg.file}")`;
    layer.classList.add("active");
    RageMode.setBackgroundActive(true);
  }
}
/** Populates the Ambience picker in Settings (Intense Smoke / Off).
 *  Like the background picker, this is always visible so it can be set
 *  up in advance, but only ever actually affects the screen while Rage
 *  Mode is switched on. */
function renderRageDripGrid() {
  const grid = document.getElementById("rageDripGrid");
  if (!grid) return;
  grid.innerHTML = RAGE_DRIP_TYPES.map(d => `
    <div class="rage-drip-option ${state.settings.rageDripType === d.id ? "active" : ""}" data-rage-drip="${d.id}">
      <span class="icon">${d.label.split(" ")[0]}</span>
      <div class="lbl">${d.label.replace(/^\S+\s/, "")}</div>
    </div>`).join("");
}
function applyRageDripType() {
  RageMode.setDripType(state.settings.rageDripType || "smoke");
}
function renderArtStyleGrid() {
  const grid = document.getElementById("artStyleGrid");
  if (!grid) return;
  grid.innerHTML = window.VV.ART_STYLES.map(s => `
    <div class="art-style-option ${state.settings.artStyle === s.id ? "active" : ""}" data-art-style="${s.id}">
      <img src="${window.VV.generatedArt("Vvynas Vane", 88, s.id)}" alt="">
      <div class="lbl">${s.label}</div>
    </div>`).join("");
}

/* ---------------------------------------------------------------------
   Custom RGB accent colors — overrides the default Westeros gold/crimson
   across every place --accent/--accent2 (and their derived shades) are
   used: buttons, highlights, active states, seek bar, sigil art glow, etc.
   --------------------------------------------------------------------- */
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 201, g: 168, b: 76 };
}
function rgbToHex(r, g, b) { return "#" + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join(""); }
function shadeColor(hex, factor) { const { r, g, b } = hexToRgb(hex); return rgbToHex(r * factor, g * factor, b * factor); }
function rgba(hex, alpha) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${alpha})`; }
/** Perceived brightness (0-255) of a hex color, ITU-R BT.601 luma weights —
 *  cheap and good enough to decide "is this light or dark" for contrast
 *  purposes, no need for full WCAG relative-luminance math here. */
function perceivedBrightness(hex) { const { r, g, b } = hexToRgb(hex); return (r * 299 + g * 587 + b * 114) / 1000; }
/** WCAG relative luminance + contrast ratio, used to pick a text/icon ink
 *  color that's actually readable against a given background — see
 *  pickInkForStops() below for why this replaced the old single-color
 *  brightness check. */
function relLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const [R, G, B] = [chan(r), chan(g), chan(b)];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrastRatio(hex1, hex2) {
  const l1 = relLuminance(hex1), l2 = relLuminance(hex2);
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}
/** Every solid-accent control (the "Create" button, play button, selected
 *  checkmark...) is actually painted with a gradient from `top` to `bottom`
 *  (e.g. --accent to --accent-dark), not a flat color. Picking the ink by
 *  only checking brightness of the TOP stop used to leave the bottom of the
 *  gradient under-contrast for plenty of accent colors (including the
 *  default gold, whose gradient bottom only hit ~4:1 against dark ink —
 *  under the 4.5:1 AA minimum). This is the actual bug behind "Create"
 *  sometimes being hard to read: it depended on where in the gradient the
 *  text sat, not just which accent was picked. Instead, test BOTH
 *  candidate inks against BOTH gradient stops and keep whichever ink wins
 *  the worst-case (minimum) contrast, so the button stays legible end to
 *  end regardless of the accent color. */
function pickInkForStops(top, bottom) {
  const DARK_INK = "#16110a", LIGHT_INK = "#F5EFE0";
  const worstFor = (ink) => Math.min(contrastRatio(ink, top), contrastRatio(ink, bottom));
  return worstFor(DARK_INK) >= worstFor(LIGHT_INK) ? DARK_INK : LIGHT_INK;
}

function applyAccentColors() {
  const root = document.documentElement.style;
  const a = state.settings.accentColor || "#C9A84C";
  const a2 = state.settings.accent2Color || "#B22222";
  const accentDark = shadeColor(a, 0.68);
  // Text-bearing accent gradients (the "Create" button, play button...)
  // use a shallower darken factor than decorative-only accent-dark uses
  // elsewhere. A wide gradient range means no single ink color can stay
  // AA-legible across the whole thing — at the old 0.68 factor, even the
  // default gold theme's gradient bottom only hit ~4:1 against dark ink,
  // under the 4.5:1 minimum. Narrowing the range for text buttons keeps
  // the visual gradient while leaving enough headroom for one ink color
  // to read clearly end to end.
  const accentTextDark = shadeColor(a, 0.85);
  root.setProperty("--accent", a);
  root.setProperty("--accent-dark", accentDark);
  root.setProperty("--accent-text-dark", accentTextDark);
  root.setProperty("--accent-dim", rgba(a, 0.33));
  root.setProperty("--ripple", rgba(a, 0.13));
  root.setProperty("--accent2", a2);
  root.setProperty("--accent2-dim", rgba(a2, 0.33));
  // Ink color for anything painted with the accent gradient (the "Create"
  // button, play button, selected-row checkmark, art-edit hover state...).
  // See pickInkForStops() for why this checks contrast against BOTH ends
  // of the (narrower) text gradient, not just the accent color.
  const ink = pickInkForStops(a, accentTextDark);
  root.setProperty("--accent-ink", ink);
  if (els.accentColorInput) { els.accentColorInput.value = a; els.accentColorHex.textContent = a.toUpperCase(); }
  if (els.accent2ColorInput) { els.accent2ColorInput.value = a2; els.accent2ColorHex.textContent = a2.toUpperCase(); }
}

function renderFontGrid() {
  const grid = document.getElementById("fontGrid");
  if (!grid) return;
  grid.innerHTML = window.VV.FONTS.map(f => `
    <div class="font-option ${state.settings.fontStyle === f.id ? "active" : ""}" data-font-id="${f.id}">
      <div class="sample" style="font-family:${f.stack};font-weight:${f.weight};">Aa Vvynas</div>
      <div class="lbl">${f.label}</div>
    </div>`).join("");
}
function renderThemeGrid() {
  const grid = document.getElementById("themeGrid");
  if (!grid) return;
  const presetTiles = window.VV.ThemeEngine.THEME_LIST.map(t => `
    <div class="theme-option ${state.settings.themeId === t.id ? "active" : ""}" data-theme-id="${t.id}">${t.label}</div>`).join("");
  // A user-uploaded video, if one is stored, gets its own selectable
  // full-width tile (with a live muted preview + a ✕ to remove it).
  const videoTile = customBgVideoObjectUrl ? `
    <div class="theme-option theme-video-option ${state.settings.themeId === "customVideo" ? "active" : ""}" data-theme-id="customVideo">
      <video class="video-thumb" src="${customBgVideoObjectUrl}" muted loop autoplay playsinline></video>
      <div class="lbl">My Video</div>
      <span class="rage-bg-remove" data-remove-custom-video title="Remove uploaded video">✕</span>
    </div>` : "";
  // Always-present tile that opens the device file picker.
  const uploadTile = `
    <div class="theme-option theme-video-option theme-video-upload" data-upload-video>
      <div class="video-thumb">🎬</div>
      <div class="lbl">${customBgVideoObjectUrl ? "Replace Video" : "Upload Your Own Video"}</div>
    </div>`;
  grid.innerHTML = presetTiles + videoTile + uploadTile;
}
/** Shows/hides the custom-video background layer and keeps it playing in
 *  sync with whether it's the currently selected "theme". Since
 *  "customVideo" isn't one of ThemeEngine's known theme ids, the canvas
 *  it would otherwise draw on already renders nothing for it — this just
 *  layers the actual <video> on top when it's active. */
function applyThemeVideo() {
  const layer = document.getElementById("bgVideoLayer");
  if (!layer) return;
  if (state.settings.themeId === "customVideo" && customBgVideoObjectUrl) {
    if (layer.src !== customBgVideoObjectUrl) layer.src = customBgVideoObjectUrl;
    layer.classList.add("active");
    layer.play().catch(() => { /* autoplay may need a user gesture on some browsers — it'll start on first interaction */ });
  } else {
    layer.classList.remove("active");
    layer.pause();
  }
}
/** Maps Settings → "Now Playing Overlay Strength" (0-100) onto the CSS
 *  variables the full player's scrim and the song-title/artist text
 *  shadows read from, so the details stay legible whether the chosen
 *  background is a busy video, a bright photo, or a dark canvas theme.
 *  0 = background maximally visible, 100 = details maximally shielded. */
function applyOverlayStrength() {
  const v = state.settings.overlayStrength ?? 55;
  const t = Math.max(0, Math.min(100, v)) / 100;
  const root = document.documentElement.style;
  root.setProperty("--np-overlay-a", (0.08 + t * 0.62).toFixed(2));
  root.setProperty("--np-overlay-mid", (0.20 + t * 0.65).toFixed(2));
  root.setProperty("--np-overlay-b", (0.35 + t * 0.55).toFixed(2));
  root.setProperty("--np-text-shadow-blur", (2 + t * 12).toFixed(1) + "px");
  root.setProperty("--np-text-shadow-a", (0.25 + t * 0.6).toFixed(2));
  root.setProperty("--np-mini-bg-a", (0.55 + t * 0.4).toFixed(2));
  if (els.overlayStrengthInput) els.overlayStrengthInput.value = String(v);
  if (els.overlayStrengthValue) els.overlayStrengthValue.textContent = v + "%";
}
function openSettings() { els.settingsModalOverlay.classList.add("open"); renderFontGrid(); renderThemeGrid(); renderArtStyleGrid(); renderRageBgGrid(); renderRageDripGrid(); }
function closeSettings() { els.settingsModalOverlay.classList.remove("open"); }

/* ---------------------------------------------------------------------
   PWA install (beforeinstallprompt + iOS fallback) & service worker
   --------------------------------------------------------------------- */
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream; }
function isStandalone() { return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true; }

async function triggerInstall() {
  if (isStandalone()) { toast("Already installed."); return; }
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === "accepted") toast("Installed to your home screen.");
  } else if (isIOS()) {
    els.iosModalOverlay.classList.add("open");
  } else {
    toast("Use your browser menu → \"Install app\" or \"Add to Home Screen\".");
  }
}

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* ---------------------------------------------------------------------
   Event wiring
   --------------------------------------------------------------------- */
els.grantAccessBtn.onclick = requestFolderAccess; // single handler — showResumePrompt() reassigns this same property, never adds a second listener
els.rescanBtn.addEventListener("click", requestFolderAccess);
els.settingsRescanBtn.addEventListener("click", () => { closeSettings(); requestFolderAccess(); });
els.installSidebarBtn.addEventListener("click", triggerInstall);

els.navItems.forEach(btn => btn.addEventListener("click", () => navigateTo(btn.dataset.view)));
els.tabbarBtns.forEach(btn => btn.addEventListener("click", () => {
  if (btn.dataset.action === "settings") openSettings();
  else navigateTo(btn.dataset.view);
}));

els.searchInput.addEventListener("input", (e) => { state.search = e.target.value; render(); });
els.sortSelect.addEventListener("change", (e) => { state.sort = e.target.value; render(); });
els.shuffleAllBtn.addEventListener("click", shufflePlayAll);

els.settingsBtn.addEventListener("click", openSettings);
els.closeSettingsBtn.addEventListener("click", closeSettings);
els.settingsModalOverlay.addEventListener("click", (e) => { if (e.target === els.settingsModalOverlay) closeSettings(); });
els.lightModeSwitch.addEventListener("click", () => { state.settings.light = !state.settings.light; applySettingsToUI(); saveSettings(); });
els.resumeSwitch.addEventListener("click", () => { state.settings.resume = !state.settings.resume; applySettingsToUI(); saveSettings(); });
els.rageModeSwitch.addEventListener("click", () => {
  state.settings.rageMode = !state.settings.rageMode;
  try { RageMode.ensureAudioGraph(); } catch (err) { console.warn("Rage Mode: audio graph setup failed, continuing without it", err); } // must run inside this click's user-gesture to satisfy AudioContext autoplay rules
  applySettingsToUI(); saveSettings();
  if (state.settings.rageMode) { try { RageMode.playGlitchIntro(); } catch (err) { console.warn("Rage Mode: glitch intro failed, mode is still on", err); } }
  toast(state.settings.rageMode ? "🔥 Rage Mode engaged" : "Rage Mode off");
});
els.accentColorInput.addEventListener("input", () => { state.settings.accentColor = els.accentColorInput.value; applyAccentColors(); });
els.accentColorInput.addEventListener("change", saveSettings);
els.accent2ColorInput.addEventListener("input", () => { state.settings.accent2Color = els.accent2ColorInput.value; applyAccentColors(); });
els.accent2ColorInput.addEventListener("change", saveSettings);
els.resetColorsBtn.addEventListener("click", () => {
  state.settings.accentColor = "#C9A84C"; state.settings.accent2Color = "#B22222";
  applyAccentColors(); saveSettings(); toast("Colors reset to Westeros gold.");
});

document.getElementById("fontGrid").addEventListener("click", (e) => {
  const opt = e.target.closest("[data-font-id]");
  if (!opt) return;
  state.settings.fontStyle = Number(opt.dataset.fontId);
  applySettingsToUI(); saveSettings();
});
document.getElementById("themeGrid").addEventListener("click", (e) => {
  const removeBtn = e.target.closest("[data-remove-custom-video]");
  if (removeBtn) { e.stopPropagation(); removeCustomBgVideo(); return; }
  const uploadTile = e.target.closest("[data-upload-video]");
  if (uploadTile) { document.getElementById("themeVideoUploadInput").click(); return; }
  const opt = e.target.closest("[data-theme-id]");
  if (!opt) return;
  state.settings.themeId = opt.dataset.themeId;
  applySettingsToUI(); saveSettings();
  toast(opt.dataset.themeId === "none" ? "Background off" : opt.dataset.themeId === "customVideo" ? "Background: My Video" : `Theme: ${opt.textContent}`);
});
/** Reads a device video picked via the hidden file input, stores it as a
 *  Blob in IndexedDB so it persists across reloads, and selects it as
 *  the active animated background immediately. */
document.getElementById("themeVideoUploadInput").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // reset so choosing the same file again still fires "change"
  if (!file) return;
  if (!file.type.startsWith("video/")) { toast("Please choose a video file."); return; }
  if (file.size > CUSTOM_BG_VIDEO_MAX_BYTES) { toast("That video is too large — please pick one under 60MB."); return; }
  await idbSet("kv", "customBgVideo", file);
  if (customBgVideoObjectUrl) URL.revokeObjectURL(customBgVideoObjectUrl);
  customBgVideoObjectUrl = URL.createObjectURL(file);
  state.settings.themeId = "customVideo";
  applySettingsToUI(); saveSettings();
  toast("Background video uploaded.");
});
/** Deletes the stored custom background video. Falls back to "None" if
 *  it was the active background. */
async function removeCustomBgVideo() {
  await idbDelete("kv", "customBgVideo");
  if (customBgVideoObjectUrl) { URL.revokeObjectURL(customBgVideoObjectUrl); customBgVideoObjectUrl = null; }
  if (state.settings.themeId === "customVideo") state.settings.themeId = "none";
  applySettingsToUI(); saveSettings();
  toast("Background video removed.");
}
els.overlayStrengthInput.addEventListener("input", () => {
  state.settings.overlayStrength = Number(els.overlayStrengthInput.value);
  applyOverlayStrength();
});
els.overlayStrengthInput.addEventListener("change", saveSettings);
document.getElementById("rageBgGrid").addEventListener("click", (e) => {
  const removeBtn = e.target.closest("[data-remove-custom-bg]");
  if (removeBtn) { e.stopPropagation(); removeCustomBgImage(); return; }
  const uploadTile = e.target.closest("[data-upload-bg]");
  if (uploadTile) { document.getElementById("rageBgUploadInput").click(); return; }
  const opt = e.target.closest(".rage-bg-option[data-rage-bg]");
  if (!opt) return;
  state.settings.rageBackground = opt.dataset.rageBg;
  renderRageBgGrid(); applyRageBackground(); saveSettings();
});
/** Reads a device photo picked via the hidden file input, stores it as a
 *  Blob in IndexedDB so it persists across reloads, and selects it as
 *  the active background image immediately. */
document.getElementById("rageBgUploadInput").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // reset so choosing the same file again still fires "change"
  if (!file) return;
  if (!file.type.startsWith("image/")) { toast("Please choose an image file."); return; }
  if (file.size > CUSTOM_BG_MAX_BYTES) { toast("That image is too large — please pick one under 8MB."); return; }
  await idbSet("kv", "customBgImage", file);
  if (customBgObjectUrl) URL.revokeObjectURL(customBgObjectUrl);
  customBgObjectUrl = URL.createObjectURL(file);
  state.settings.rageBackground = "custom";
  renderRageBgGrid(); applyRageBackground(); saveSettings();
  toast("Background photo uploaded.");
});
/** Deletes the stored custom background photo. Falls back to "None" if
 *  it was the active background. */
async function removeCustomBgImage() {
  await idbDelete("kv", "customBgImage");
  if (customBgObjectUrl) { URL.revokeObjectURL(customBgObjectUrl); customBgObjectUrl = null; }
  if (state.settings.rageBackground === "custom") state.settings.rageBackground = "none";
  renderRageBgGrid(); applyRageBackground(); saveSettings();
  toast("Background photo removed.");
}
document.getElementById("rageDripGrid").addEventListener("click", (e) => {
  const opt = e.target.closest(".rage-drip-option");
  if (!opt) return;
  state.settings.rageDripType = opt.dataset.rageDrip;
  renderRageDripGrid(); applyRageDripType(); saveSettings();
});
document.getElementById("artStyleGrid").addEventListener("click", (e) => {
  const opt = e.target.closest("[data-art-style]");
  if (!opt) return;
  state.settings.artStyle = opt.dataset.artStyle;
  applySettingsToUI(); saveSettings();
  toast(`Album art: ${opt.querySelector(".lbl").textContent}`);
});

els.closeIosModalBtn.addEventListener("click", () => els.iosModalOverlay.classList.remove("open"));
els.iosModalOverlay.addEventListener("click", (e) => { if (e.target === els.iosModalOverlay) els.iosModalOverlay.classList.remove("open"); });

// Content clicks (delegated) — song rows, folder/playlist cards, action buttons
els.contentScroll.addEventListener("click", (e) => {
  const favBtn = e.target.closest('[data-action="fav"]');
  if (favBtn) { window.VV.PixieDust.burstFromEl(favBtn); toggleFavorite(favBtn.dataset.id); return; }
  const queueBtn = e.target.closest('[data-action="queue"]');
  if (queueBtn) { window.VV.PixieDust.burstFromEl(queueBtn); addToQueueNext(queueBtn.dataset.id); return; }
  const moreBtn = e.target.closest('[data-action="more"]');
  if (moreBtn) { openPlaylistModal(moreBtn.dataset.id); return; }
  const rmBtn = e.target.closest('[data-action="remove-from-playlist"]');
  if (rmBtn) { removeSongFromPlaylist(rmBtn.dataset.playlist, rmBtn.dataset.id); return; }
  const delPl = e.target.closest('[data-action="delete-playlist"]');
  if (delPl) { if (confirm("Delete this playlist?")) deletePlaylist(delPl.dataset.id); return; }
  const renamePl = e.target.closest('[data-action="rename-playlist"]');
  if (renamePl) { openRenamePlaylistModal(renamePl.dataset.id); return; }
  const clearRecent = e.target.closest('[data-action="clear-recent"]');
  if (clearRecent) { if (confirm("Clear your Recently Played history?")) clearRecentlyPlayed(); return; }
  const backFolders = e.target.closest('[data-action="back-folders"]');
  if (backFolders) { navigateTo("folders"); return; }
  const backPlaylists = e.target.closest('[data-action="back-playlists"]');
  if (backPlaylists) { navigateTo("playlists"); return; }

  // Multi-select mode: toggle mode, toggle one row, select-all, remove-selected, cancel.
  const toggleModeBtn = e.target.closest('[data-action="toggle-select-mode"]');
  if (toggleModeBtn) { state.selectMode = !state.selectMode; state.selectedIds.clear(); render(); return; }
  const cancelSelectBtn = e.target.closest('[data-action="cancel-select"]');
  if (cancelSelectBtn) { state.selectMode = false; state.selectedIds.clear(); render(); return; }
  const selectAllBtn = e.target.closest('[data-action="select-all"]');
  if (selectAllBtn) {
    const idsInView = currentSelectableSongIds();
    const allSelected = idsInView.length > 0 && idsInView.every(id => state.selectedIds.has(id));
    if (allSelected) state.selectedIds.clear();
    else idsInView.forEach(id => state.selectedIds.add(id));
    render();
    return;
  }
  const removeSelectedBtn = e.target.closest('[data-action="remove-selected"]');
  if (removeSelectedBtn && !removeSelectedBtn.disabled) { performBulkRemove(); return; }
  const checkEl = e.target.closest('[data-action="toggle-select"]');
  if (checkEl) { toggleRowSelected(checkEl.dataset.id); return; }

  const folderCard = e.target.closest("[data-folder]");
  if (folderCard) { state.currentFolder = decodeURIComponent(folderCard.dataset.folder); navigateTo("folder-detail"); return; }

  const newPlCard = e.target.closest("#newPlaylistCard");
  if (newPlCard) { openNewPlaylistModal(); return; }
  const recentCard = e.target.closest('[data-view-jump="recent"]');
  if (recentCard) { navigateTo("recent"); return; }
  const plCard = e.target.closest("[data-playlist]");
  if (plCard) { state.currentPlaylist = plCard.dataset.playlist; navigateTo("playlist-detail"); return; }

  const row = e.target.closest(".song-row");
  if (row) {
    const id = row.dataset.id;
    if (state.selectMode) { toggleRowSelected(id); return; }
    window.VV.PixieDust.burstFromEl(row);
    let queueList;
    if (state.currentView === "folder-detail") queueList = visibleSongs(state.songs.filter(s => (state.foldersMap.get(state.currentFolder) || []).includes(s.id))).map(s => s.id);
    else if (state.currentView === "playlist-detail") { const pl = state.playlists.find(p => p.id === state.currentPlaylist); queueList = visibleSongs(pl.songIds.map(sid => state.songs.find(s => s.id === sid)).filter(Boolean)).map(s => s.id); }
    else if (state.currentView === "favorites") queueList = visibleSongs(state.songs.filter(s => state.favorites.has(s.id))).map(s => s.id);
    else if (state.currentView === "recent") queueList = visibleSongs(recentlyPlayedSongs()).map(s => s.id);
    else queueList = visibleSongs(state.songs).map(s => s.id);
    playSongId(id, queueList);
    openPlayer();
  }
});

/* ---------------------------------------------------------------------
   Multi-select helpers
   --------------------------------------------------------------------- */
function currentSelectableSongIds() {
  if (state.currentView === "favorites") return visibleSongs(state.songs.filter(s => state.favorites.has(s.id))).map(s => s.id);
  if (state.currentView === "recent") return visibleSongs(recentlyPlayedSongs()).map(s => s.id);
  if (state.currentView === "playlist-detail") {
    const pl = state.playlists.find(p => p.id === state.currentPlaylist);
    return pl ? visibleSongs(pl.songIds.map(id => state.songs.find(s => s.id === id)).filter(Boolean)).map(s => s.id) : [];
  }
  return [];
}
function toggleRowSelected(id) {
  if (state.selectedIds.has(id)) state.selectedIds.delete(id); else state.selectedIds.add(id);
  render();
}
async function performBulkRemove() {
  const ids = Array.from(state.selectedIds);
  if (!ids.length) return;
  if (state.currentView === "favorites") {
    await removeFavorites(ids);
    toast(`Removed ${ids.length} favorite${ids.length === 1 ? "" : "s"}`);
  } else if (state.currentView === "recent") {
    await removeFromRecentlyPlayed(ids);
    toast(`Removed ${ids.length} from history`);
  } else if (state.currentView === "playlist-detail") {
    await removeSongsFromPlaylist(state.currentPlaylist, ids);
    toast(`Removed ${ids.length} song${ids.length === 1 ? "" : "s"} from playlist`);
  }
  state.selectMode = false;
  state.selectedIds.clear();
  render();
}

// Playlist pick modal
els.playlistPickList.addEventListener("click", (e) => {
  const row = e.target.closest("[data-playlist]");
  if (row && state.addToPlaylistTargetId) { addSongToPlaylist(row.dataset.playlist, state.addToPlaylistTargetId); closePlaylistModal(); }
});
els.newPlaylistFromModalBtn.addEventListener("click", () => { closePlaylistModal(); openNewPlaylistModal(); });
els.closePlaylistModalBtn.addEventListener("click", closePlaylistModal);
els.playlistModalOverlay.addEventListener("click", (e) => { if (e.target === els.playlistModalOverlay) closePlaylistModal(); });

els.cancelNewPlaylistBtn.addEventListener("click", closeNewPlaylistModal);
els.newPlaylistModalOverlay.addEventListener("click", (e) => { if (e.target === els.newPlaylistModalOverlay) closeNewPlaylistModal(); });
els.confirmNewPlaylistBtn.addEventListener("click", async () => {
  const name = els.newPlaylistInput.value.trim();
  if (!name) { toast("Give it a name first."); return; }
  if (state.playlistModalMode === "rename" && state.renameTargetId) {
    await renamePlaylist(state.renameTargetId, name);
    closeNewPlaylistModal();
    return;
  }
  const pl = await createPlaylist(name);
  closeNewPlaylistModal();
  if (state.addToPlaylistTargetId) { await addSongToPlaylist(pl.id, state.addToPlaylistTargetId); state.addToPlaylistTargetId = null; }
});
els.newPlaylistInput.addEventListener("keydown", (e) => { if (e.key === "Enter") els.confirmNewPlaylistBtn.click(); });

// Mini player
els.miniPlayer.addEventListener("click", (e) => { if (!e.target.closest("button")) openPlayer(); });
els.miniPlayBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
els.miniPrevBtn.addEventListener("click", (e) => { e.stopPropagation(); prevSong(); });
els.miniNextBtn.addEventListener("click", (e) => { e.stopPropagation(); nextSong(false); });

// Full player
els.playerCollapseBtn.addEventListener("click", closePlayer);
els.playerQueueTopBtn.addEventListener("click", openQueue);
els.playBtn.addEventListener("click", togglePlay);
els.prevBtn.addEventListener("click", prevSong);
els.nextBtn.addEventListener("click", () => nextSong(false));
els.shuffleBtn.addEventListener("click", toggleShuffle);
els.repeatBtn.addEventListener("click", cycleRepeat);
els.favBtn.addEventListener("click", () => { const id = state.queue[state.queueIndex]; if (id) toggleFavorite(id); });
els.addToPlaylistBtn.addEventListener("click", () => { const id = state.queue[state.queueIndex]; if (id) openPlaylistModal(id); });
els.queueBtn.addEventListener("click", openQueue);

/* Custom album art — pick a photo from device storage for the song
   currently open in the full player. Any resolution/aspect ratio goes
   in; resizeImageFileToDataUrl (shared.js) normalizes it into a square
   512x512 JPEG so it's compatible everywhere art is shown. */
els.editArtBtn.addEventListener("click", () => {
  const id = state.queue[state.queueIndex];
  if (!id) { toast("Nothing playing yet."); return; }
  els.albumArtUploadInput.click();
});
els.albumArtUploadInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // reset so picking the same file again still fires "change"
  if (!file) return;
  const songId = state.queue[state.queueIndex];
  if (!songId) return;
  if (!file.type.startsWith("image/")) { toast("Please choose an image file."); return; }
  if (file.size > CUSTOM_BG_MAX_BYTES) { toast("That image is too large — please pick one under 8MB."); return; }
  try {
    const dataUrl = await window.VV.resizeImageFileToDataUrl(file, 512, 0.86);
    await idbSet("customArt", songId, dataUrl);
    state.customArt.set(songId, dataUrl);
    const song = state.songs.find(s => s.id === songId);
    if (song) { syncNowPlayingUI(song); updateMediaSession(song); }
    render(); // library rows / playlists picking up the new art
    toast("Album art updated.");
  } catch {
    toast("Couldn't read that image — try a different file.");
  }
});
els.resetArtBtn.addEventListener("click", async () => {
  const songId = state.queue[state.queueIndex];
  if (!songId || !state.customArt.has(songId)) return;
  await idbDelete("customArt", songId);
  state.customArt.delete(songId);
  const song = state.songs.find(s => s.id === songId);
  if (song) { syncNowPlayingUI(song); updateMediaSession(song); }
  render();
  toast("Album art reset to default.");
});

els.closeQueueBtn.addEventListener("click", closeQueue);
els.sheetOverlay.addEventListener("click", closeQueue);
els.queueList.addEventListener("click", (e) => {
  const rmBtn = e.target.closest('[data-action="remove-from-queue"]');
  if (rmBtn) {
    const idx = Number(rmBtn.dataset.queueIndex);
    state.queue.splice(idx, 1);
    if (idx < state.queueIndex) state.queueIndex--;
    else if (idx === state.queueIndex) state.queueIndex = Math.min(state.queueIndex, state.queue.length - 1);
    renderQueueSheet();
    render();
    return;
  }
  const row = e.target.closest(".song-row");
  if (row) { state.queueIndex = Number(row.dataset.queueIndex); loadAndPlayCurrent(); closeQueue(); }
});

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.code === "ArrowRight" && e.shiftKey) nextSong(false);
  else if (e.code === "ArrowLeft" && e.shiftKey) prevSong();
});

window.addEventListener("resize", () => {
  const mobile = window.innerWidth < 900;
  const appLoaded = els.appBody && !els.appBody.classList.contains("hidden");
  els.tabbar.classList.toggle("hidden", !mobile || !appLoaded);
});

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
async function boot() {
  await loadUserData();
  if (fsApiSupported()) {
    els.fsApiNote.textContent = "Your browser will remember this folder next time you open the app.";
  } else {
    els.fsApiNote.textContent = "Your browser will ask you to re-select the folder each visit — your files still never leave your device.";
  }
  if (state.settings.resume) {
    const result = await tryResumeFolder();
    if (result === true) return; // onboarding already dismissed inside scan
  }
  // still on onboarding screen — nothing else to do until user grants access
}

boot();

})();
