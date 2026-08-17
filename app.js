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
const { idbGet, idbSet, idbDelete, idbGetAll, idbGetAllKeys, idbPut } = window.VV;

/* ---------------------------------------------------------------------
   State
   --------------------------------------------------------------------- */
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|weba|webm)$/i;
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
  settings: { light: false, resume: true, fontStyle: 0, themeId: "none" },
  usingFSApi: false,
  fileRefs: new Map(),   // songId -> File or FileSystemFileHandle
  objectUrl: null,
  artCache: new Map(),   // songId -> dataURL
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
  closeSettingsBtn: $("#closeSettingsBtn"),
  settingsRescanBtn: $("#settingsRescanBtn"),

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

/* Deterministic sigil-style generated album art (canvas -> dataURL), cached */
const SIGIL_PALETTES = [
  ["#C9A84C", "#8A6E2A", "#1A1410"],
  ["#B22222", "#6b1414", "#1A1410"],
  ["#8B9CA8", "#3f4c55", "#110E0B"],
  ["#4A7C59", "#274430", "#110E0B"],
  ["#2E4A6A", "#182838", "#0A0806"],
  ["#CC5500", "#7a3300", "#1A1410"],
];
function generatedArt(seedStr, size = 200) {
  if (state.artCache.has(seedStr)) return state.artCache.get(seedStr);
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  const h = Math.abs(hashStr(seedStr).split("").reduce((a, c) => a + c.charCodeAt(0), 0));
  const pal = SIGIL_PALETTES[h % SIGIL_PALETTES.length];
  const grad = ctx.createRadialGradient(size*0.5, size*0.4, size*0.05, size*0.5, size*0.5, size*0.75);
  grad.addColorStop(0, pal[1]);
  grad.addColorStop(1, pal[2]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // outer ring
  ctx.strokeStyle = pal[0];
  ctx.lineWidth = size * 0.02;
  ctx.beginPath();
  ctx.arc(size/2, size/2, size*0.4, 0, Math.PI*2);
  ctx.stroke();
  // diamond sigil rotated by hash
  const rot = (h % 8) * (Math.PI / 16);
  ctx.save();
  ctx.translate(size/2, size/2);
  ctx.rotate(rot);
  ctx.fillStyle = pal[0];
  const r2 = size * 0.24;
  ctx.beginPath();
  ctx.moveTo(0, -r2); ctx.lineTo(r2*0.62, 0); ctx.lineTo(0, r2); ctx.lineTo(-r2*0.62, 0);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  // initial letter
  const letter = (seedStr.trim()[0] || "V").toUpperCase();
  ctx.fillStyle = pal[2];
  ctx.font = `700 ${size*0.16}px Cinzel, Georgia, serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(letter, size/2, size/2 + size*0.01);
  const url = canvas.toDataURL("image/png");
  state.artCache.set(seedStr, url);
  return url;
}
function artHtml(song, sizeAttr = "") {
  const url = generatedArt(song.title + song.artist + song.id, 160);
  return `<img src="${url}" alt="" loading="lazy">`;
}

/* ---------------------------------------------------------------------
   Animated background (42 themes), globe title, pixie dust, book transition
   — all ported 1:1 from the Android app's view classes; see shared.js.
   --------------------------------------------------------------------- */
window.VV.ThemeEngine.init(document.getElementById("themeCanvas"));
window.VV.GlobeTitle.init(document.getElementById("globeTitleCanvas"));
window.VV.PixieDust.init(document.getElementById("pixieCanvas"));
window.VV.BookTransition.init("bookTransition");

const RAVEN_LINES = ["RAVENS DISPATCHED...", "SCROLLS UNSEALED", "THE LIBRARY AWAITS", "SONGS OF WESTEROS"];
function updateRavensLine() {
  const el = document.getElementById("ravensLine");
  if (el) el.textContent = state.songs.length ? `${state.songs.length} SONG${state.songs.length === 1 ? "" : "S"} CATALOGUED` : RAVEN_LINES[0];
}

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
  const [playlists, favKeys, pcEntries, settings, recent] = await Promise.all([
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
  ]);
  state.playlists = playlists || [];
  state.favorites = new Set(favKeys || []);
  state.playCounts = new Map(pcEntries || []);
  state.recentlyPlayed = recent || [];
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
  audio.src = state.objectUrl;
  try { await audio.play(); state.isPlaying = true; }
  catch (err) { state.isPlaying = false; }
  bumpPlayCount(songId);
  bumpMonthStat(song);
  recordRecentlyPlayed(songId);
  window.VV.BookTransition.play();
  syncNowPlayingUI(song);
  updateMediaSession(song);
  render();
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
  setPlayIcon(state.isPlaying);
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
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title, artist: song.artist, album: song.album || "Vvynas Vane",
    artwork: [{ src: generatedArt(song.title + song.artist + song.id, 512), sizes: "512x512", type: "image/png" }],
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
  window.VV.applyFont(state.settings.fontStyle);
  window.VV.ThemeEngine.setTheme(state.settings.themeId);
  renderFontGrid();
  renderThemeGrid();
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
  grid.innerHTML = window.VV.ThemeEngine.THEME_LIST.map(t => `
    <div class="theme-option ${state.settings.themeId === t.id ? "active" : ""}" data-theme-id="${t.id}">${t.label}</div>`).join("");
}
function openSettings() { els.settingsModalOverlay.classList.add("open"); renderFontGrid(); renderThemeGrid(); }
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

document.getElementById("fontGrid").addEventListener("click", (e) => {
  const opt = e.target.closest("[data-font-id]");
  if (!opt) return;
  state.settings.fontStyle = Number(opt.dataset.fontId);
  applySettingsToUI(); saveSettings();
});
document.getElementById("themeGrid").addEventListener("click", (e) => {
  const opt = e.target.closest("[data-theme-id]");
  if (!opt) return;
  state.settings.themeId = opt.dataset.themeId;
  applySettingsToUI(); saveSettings();
  toast(opt.dataset.themeId === "none" ? "Background off" : `Theme: ${opt.textContent}`);
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
