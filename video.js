/* =========================================================================
   VVYNAS VANE — VIDEO PLAYER
   A simple, standard player for video (mp4/mkv/webm/mov/m4v/avi) and M4A
   files, plus subtitles. Deliberately undecorated — no animated theme, no
   page-turn transition.

   Playback strategy (deliberately conservative — "best all-time working
   methods" over anything experimental):
   - Wrap every file in a Blob with the CORRECT MIME type before creating
     an object URL. Browsers often can't guess the right type from a raw
     File for less common extensions (.mkv especially), which silently
     breaks codec/container detection.
   - MKV plays natively wherever the browser's own Matroska demuxer
     supports the codecs inside it (Chrome/Edge/Firefox: H.264 or VP9/VP8
     video + AAC/Opus/Vorbis/MP3 audio — the large majority of real-world
     MKV rips). There is no reliable, stable, purely-client-side way to
     decode codecs a browser doesn't support (e.g. HEVC in Chrome) without
     a heavy WASM transcoder that is neither fast nor stable enough for a
     general video player, so this deliberately does NOT attempt that.
   - When a video track fails to decode but audio keeps playing (the
     classic "MKV plays audio only" symptom), that's detected directly
     (videoWidth/videoHeight stay 0 on a file that isn't audio-only) and
     explained in the UI instead of leaving a silent blank frame.

   Subtitles: native <track kind="subtitles"> + WebVTT, the one subtitle
   format every browser supports natively with zero dependencies.
   - SRT files are auto-converted to VTT in-browser (well-established,
     mechanical conversion: header + comma-to-period timestamps).
   - Sibling subtitle files (same base filename as the video, in the same
     folder) are auto-detected from the same folder scan and offered
     immediately; any other .srt/.vtt file can also be loaded manually.
   ========================================================================= */
(() => {
"use strict";
const { idbGet, idbSet, fsApiSupported, verifyPermission, pickDirectory, getStoredHandle, walkDirectory } = window.VV;

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi)$/i;
const M4A_EXT = /\.m4a$/i;
const SUB_EXT = /\.(srt|vtt)$/i;
const ALL_EXT = /\.(mp4|mkv|webm|mov|m4v|avi|m4a|srt|vtt)$/i;

// Explicit MIME map — do not rely on File.type, which is frequently empty
// or wrong for less common extensions (.mkv above all) depending on OS/browser.
const MIME_BY_EXT = {
  mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", mkv: "video/x-matroska",
  mov: "video/quicktime", avi: "video/x-msvideo", m4a: "audio/mp4",
};

// Language codes recognized in subtitle filenames, e.g. "Movie.en.srt",
// "Movie.eng.srt", "Movie.english.srt" — the standard convention most
// subtitle sites and rippers use. Keyed by every alias, so lookups are a
// single object hit regardless of which form the file uses.
const LANGUAGE_ALIASES = {
  en: "English", eng: "English", english: "English",
  fr: "French", fre: "French", fra: "French", french: "French",
  es: "Spanish", spa: "Spanish", spanish: "Spanish",
  de: "German", ger: "German", deu: "German", german: "German",
  it: "Italian", ita: "Italian", italian: "Italian",
  pt: "Portuguese", por: "Portuguese", portuguese: "Portuguese", "pt-br": "Portuguese (Brazil)",
  ja: "Japanese", jpn: "Japanese", japanese: "Japanese",
  ko: "Korean", kor: "Korean", korean: "Korean",
  zh: "Chinese", chi: "Chinese", zho: "Chinese", chinese: "Chinese",
  ar: "Arabic", ara: "Arabic", arabic: "Arabic",
  ru: "Russian", rus: "Russian", russian: "Russian",
  hi: "Hindi", hin: "Hindi", hindi: "Hindi",
  nl: "Dutch", dut: "Dutch", nld: "Dutch", dutch: "Dutch",
  sv: "Swedish", swe: "Swedish", swedish: "Swedish",
  tr: "Turkish", tur: "Turkish", turkish: "Turkish",
  pl: "Polish", pol: "Polish", polish: "Polish",
  vi: "Vietnamese", vie: "Vietnamese", vietnamese: "Vietnamese",
  th: "Thai", tha: "Thai", thai: "Thai",
};

/** Splits "Movie Name.en.srt" into { base: "movie name", lang: "English", langCode: "en" }.
 *  Falls back to base = full filename (no language tag) when nothing matches. */
function parseSubtitleName(filename) {
  const noExt = filename.replace(SUB_EXT, "");
  const parts = noExt.split(".");
  if (parts.length > 1) {
    const tag = parts[parts.length - 1].toLowerCase();
    if (LANGUAGE_ALIASES[tag]) {
      return { base: parts.slice(0, -1).join(".").toLowerCase(), lang: LANGUAGE_ALIASES[tag], langCode: tag };
    }
  }
  return { base: noExt.toLowerCase(), lang: null, langCode: null };
}

const state = {
  videos: [], m4as: [], subs: [], fileRefs: new Map(), subRefs: new Map(),
  queue: [], queueIndex: -1, usingFSApi: false, objectUrl: null,
  currentTrackEl: null, currentSubUrl: null, currentItem: null,
  subtitleMatches: [], subtitleIndex: -1,
  preferredAudioLang: "en",
  search: "",
};

const $ = (s) => document.querySelector(s);
const els = {
  grantSection: $("#grantSection"), grantBtn: $("#grantBtn"), playerSection: $("#playerSection"),
  scanningSection: $("#scanningSection"), scanningStatus: $("#scanningStatus"),
  vpStage: $("#vpStage"), vpEmptyStage: $("#vpEmptyStage"), video: $("#vpVideo"),
  warning: $("#vpWarning"), warningText: $("#vpWarningText"),
  title: $("#vpTitle"), sub: $("#vpSub"),
  prevBtn: $("#vpPrevBtn"), playBtn: $("#vpPlayBtn"), playIcon: $("#vpPlayIcon"), nextBtn: $("#vpNextBtn"),
  seek: $("#vpSeek"), cur: $("#vpCur"), total: $("#vpTotal"),
  videoList: $("#videoList"), m4aList: $("#m4aList"), videoLabel: $("#videoLabel"), m4aLabel: $("#m4aLabel"),
  searchWrap: $("#vpSearchWrap"), searchInput: $("#vpSearchInput"), searchClear: $("#vpSearchClear"),
  backBtn: $("#backBtn"), fullscreenBtn: $("#fullscreenBtn"), folderFallback: $("#vpFolderFallback"),
  ccBtn: $("#ccBtn"), ccModalOverlay: $("#ccModalOverlay"), ccList: $("#ccList"),
  ccLoadFileRow: $("#ccLoadFileRow"), ccCloseBtn: $("#ccCloseBtn"), subtitleFileInput: $("#vpSubtitleFile"),
  audBtn: $("#audBtn"), audModalOverlay: $("#audModalOverlay"), audList: $("#audList"), audCloseBtn: $("#audCloseBtn"),
  toast: $("#toast"),
};

function toast(msg) { els.toast.textContent = msg; els.toast.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => els.toast.classList.remove("show"), 2400); }
function fmtTime(sec) { if (!isFinite(sec) || sec < 0) sec = 0; const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, "0")}`; }
function escapeHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function extOf(name) { return (name.split(".").pop() || "").toLowerCase(); }
function baseName(name) { return name.replace(/\.[^./]+$/, "").toLowerCase(); }

els.backBtn.addEventListener("click", () => { window.location.href = "index.html"; });
els.fullscreenBtn.addEventListener("click", () => {
  if (els.video.requestFullscreen) els.video.requestFullscreen().catch(() => toast("Fullscreen not available."));
  else toast("Fullscreen not supported in this browser.");
});

/* ---------------------------------------------------------------------
   Folder access / scanning
   --------------------------------------------------------------------- */
async function requestAccess() {
  if (fsApiSupported()) {
    const handle = await pickDirectory().catch(() => null);
    if (!handle) return;
    state.usingFSApi = true;
    await scanHandle(handle);
  } else {
    els.folderFallback.click();
  }
}
els.grantBtn.onclick = requestAccess; // single handler — reassigned on resume, never a second listener

els.folderFallback.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []).filter(f => ALL_EXT.test(f.name));
  if (!files.length) { toast("No video, M4A, or subtitle files found."); return; }
  state.usingFSApi = false;
  showScanning("Reading your folder…");
  const entries = files.map(f => ({ handle: f, path: f.webkitRelativePath || f.name }));
  buildLists(entries);
});

function showScanning(status) {
  els.grantSection.classList.add("hidden");
  els.playerSection.classList.add("hidden");
  els.scanningSection.classList.remove("hidden");
  if (status) els.scanningStatus.textContent = status;
}

async function scanHandle(handle) {
  showScanning("Searching your folder…");
  const entries = await walkDirectory(handle, ALL_EXT, (n) => { if (n % 15 === 0) els.scanningStatus.textContent = `Found ${n} files so far…`; }).catch(() => []);
  els.scanningStatus.textContent = `Cataloguing ${entries.length} file${entries.length === 1 ? "" : "s"}…`;
  buildLists(entries);
}

function buildLists(entries) {
  state.videos = []; state.m4as = []; state.subs = []; state.fileRefs.clear(); state.subRefs.clear();
  entries.forEach((e, i) => {
    const id = "v" + i + "_" + e.path.length;
    const name = e.path.split("/").pop();
    const folder = e.path.slice(0, e.path.length - name.length);
    if (SUB_EXT.test(name)) {
      state.subRefs.set(id, e.handle);
      const parsed = parseSubtitleName(name);
      state.subs.push({ id, name, folder, base: parsed.base, lang: parsed.lang, langCode: parsed.langCode });
    } else {
      state.fileRefs.set(id, e.handle);
      const item = { id, name, folder, ext: extOf(name), base: baseName(name) };
      if (M4A_EXT.test(name)) state.m4as.push(item); else state.videos.push(item);
    }
  });
  els.grantSection.classList.add("hidden");
  els.scanningSection.classList.add("hidden");
  els.playerSection.classList.remove("hidden");
  render();
}

function rowHtml(item, kind) {
  return `<div class="vp-row" data-id="${item.id}" data-kind="${kind}">
    <div class="thumb">${kind === "video"
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 9l5-3v12l-5-3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/></svg>'}</div>
    <div class="name">${escapeHtml(item.name)}</div>
    <span class="kind">${kind === "video" ? item.ext.toUpperCase() : "M4A"}</span>
  </div>`;
}

function matchesSearch(item) {
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return item.name.toLowerCase().includes(q);
}

function render() {
  const q = state.search.trim();
  const filteredVideos = state.videos.filter(matchesSearch);
  const filteredM4as = state.m4as.filter(matchesSearch);

  els.videoLabel.textContent = q ? `Video Files (${filteredVideos.length} of ${state.videos.length})` : `Video Files (${state.videos.length})`;
  els.m4aLabel.textContent = q ? `M4A Files (${filteredM4as.length} of ${state.m4as.length})` : `M4A Files (${state.m4as.length})`;

  els.videoList.innerHTML = filteredVideos.length
    ? filteredVideos.map(v => rowHtml(v, "video")).join("")
    : `<div class="vp-no-results">${q ? "No video files match your search." : "No video files found."}</div>`;
  els.m4aList.innerHTML = filteredM4as.length
    ? filteredM4as.map(v => rowHtml(v, "m4a")).join("")
    : `<div class="vp-no-results">${q ? "No M4A files match your search." : "No M4A files found."}</div>`;

  [...els.videoList.querySelectorAll(".vp-row"), ...els.m4aList.querySelectorAll(".vp-row")].forEach(row => {
    row.classList.toggle("active", state.queue[state.queueIndex] === row.dataset.id);
  });
}

async function getFile(id) {
  const ref = state.fileRefs.get(id);
  if (!ref) return null;
  if (state.usingFSApi && ref.getFile) return await ref.getFile();
  return ref;
}
async function getSubFile(id) {
  const ref = state.subRefs.get(id);
  if (!ref) return null;
  if (state.usingFSApi && ref.getFile) return await ref.getFile();
  return ref;
}

/* ---------------------------------------------------------------------
   Playback
   --------------------------------------------------------------------- */
function warn(msg) { els.warning.classList.remove("hidden"); els.warningText.innerHTML = msg; }
function clearWarn() { els.warning.classList.add("hidden"); els.warningText.innerHTML = ""; }

async function playId(id) {
  const all = [...state.videos, ...state.m4as];
  state.queue = all.map(i => i.id);
  state.queueIndex = state.queue.indexOf(id);
  const item = all.find(i => i.id === id);
  state.currentItem = item;
  clearWarn();
  clearSubtitle();

  const rawFile = await getFile(id);
  if (!rawFile) { toast("Couldn't read that file."); return; }
  // Re-wrap with the correct MIME type — this is the key fix for MKV and
  // other extensions browsers/OSes frequently fail to auto-detect.
  const mime = MIME_BY_EXT[item.ext] || rawFile.type || "";
  const typedBlob = mime && rawFile.type !== mime ? rawFile.slice(0, rawFile.size, mime) : rawFile;

  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(typedBlob);

  els.vpEmptyStage.classList.add("hidden");
  els.video.classList.remove("hidden");

  // Warn up front if the browser has no chance at all with this container/type.
  if (mime && els.video.canPlayType(mime) === "") {
    warn(`<strong>Heads up:</strong> your browser reports no support at all for <strong>.${item.ext.toUpperCase()}</strong> files. Playback may fail outright — try Chrome/Edge/Firefox, or convert the file.`);
  }

  els.video.src = state.objectUrl;
  els.video.load();
  els.video.play().catch(() => {});
  els.title.textContent = item.name;
  els.sub.textContent = M4A_EXT.test(item.name) ? "Audio (M4A)" : "Video";
  render();

  // After metadata loads, detect the classic "video track unsupported,
  // audio plays fine" case directly from the decoded dimensions.
  els.video.addEventListener("loadedmetadata", function checkVideoTrack() {
    els.video.removeEventListener("loadedmetadata", checkVideoTrack);
    const looksLikeAudioOnly = M4A_EXT.test(item.name);
    if (!looksLikeAudioOnly && els.video.videoWidth === 0 && els.video.videoHeight === 0 && els.video.duration > 0) {
      warn(`<strong>Audio only:</strong> the video track in this ${item.ext.toUpperCase()} couldn't be decoded — likely an unsupported codec (HEVC/H.265 is the most common culprit in Matroska/MKV files). Audio will keep playing. For full video, try VLC, or re-encode with H.264/VP9 video.`);
    }
    handleAudioTracks();
  }, { once: true });

  autoLoadSiblingSubtitle(item);
}

/* ---------------------------------------------------------------------
   Multi-language audio tracks — native HTMLMediaElement.audioTracks.
   Supported by Chrome/Edge/Opera for local files with multiple embedded
   audio streams (common for dubbed MKV/MP4 rips); Firefox/Safari don't
   expose it, so this quietly does nothing there rather than break.
   Default preference: switch to English automatically when more than one
   audio track is present and English isn't already the active one, and
   tell the person that happened (with a one-tap way to undo it).
   --------------------------------------------------------------------- */
function handleAudioTracks() {
  const tracks = els.video.audioTracks;
  if (!tracks || tracks.length <= 1) { els.audBtn.classList.add("hidden"); return; }
  els.audBtn.classList.remove("hidden");

  const isEnglish = (t) => /^en\b/i.test(t.language || "") || /english/i.test(t.label || "");
  let currentIdx = 0, englishIdx = -1;
  for (let i = 0; i < tracks.length; i++) { if (tracks[i].enabled) currentIdx = i; if (isEnglish(tracks[i])) englishIdx = i; }

  if (englishIdx !== -1 && englishIdx !== currentIdx) {
    for (let i = 0; i < tracks.length; i++) tracks[i].enabled = (i === englishIdx);
    toast(`Switched to English audio (${tracks.length} tracks found) — tap AUD to change`);
  } else if (englishIdx === -1) {
    toast(`${tracks.length} audio tracks found — tap AUD to choose a language`);
  }
}
function audioTrackLabel(t, i) {
  if (t.label) return t.label;
  if (t.language) return (LANGUAGE_ALIASES[t.language.toLowerCase()] || t.language.toUpperCase());
  return `Track ${i + 1}`;
}
function openAudModal() {
  const tracks = els.video.audioTracks;
  if (!tracks || !tracks.length) { els.audModalOverlay.classList.remove("open"); return; }
  const rows = [];
  for (let i = 0; i < tracks.length; i++) {
    rows.push(`<div class="cc-row ${tracks[i].enabled ? "active" : ""}" data-aud-idx="${i}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7"/></svg>
      ${escapeHtml(audioTrackLabel(tracks[i], i))}</div>`);
  }
  els.audList.innerHTML = rows.join("");
  els.audModalOverlay.classList.add("open");
}
els.audBtn.addEventListener("click", openAudModal);
els.audCloseBtn.addEventListener("click", () => els.audModalOverlay.classList.remove("open"));
els.audModalOverlay.addEventListener("click", (e) => { if (e.target === els.audModalOverlay) els.audModalOverlay.classList.remove("open"); });
els.audList.addEventListener("click", (e) => {
  const row = e.target.closest("[data-aud-idx]");
  if (!row) return;
  const tracks = els.video.audioTracks;
  const idx = Number(row.dataset.audIdx);
  for (let i = 0; i < tracks.length; i++) tracks[i].enabled = (i === idx);
  toast(`Audio: ${audioTrackLabel(tracks[idx], idx)}`);
  els.audModalOverlay.classList.remove("open");
});

function togglePlay() { if (!els.video.src) return; if (els.video.paused) els.video.play(); else els.video.pause(); }
function next() { if (!state.queue.length) return; let i = state.queueIndex + 1; if (i >= state.queue.length) i = 0; playId(state.queue[i]); }
function prev() { if (!state.queue.length) return; let i = state.queueIndex - 1; if (i < 0) i = state.queue.length - 1; playId(state.queue[i]); }

els.playBtn.addEventListener("click", togglePlay);
els.nextBtn.addEventListener("click", next);
els.prevBtn.addEventListener("click", prev);
els.video.addEventListener("play", () => { els.playIcon.innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'; });
els.video.addEventListener("pause", () => { els.playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>'; });
els.video.addEventListener("ended", next);
els.video.addEventListener("error", () => {
  const err = els.video.error;
  const codes = { 1: "loading was aborted", 2: "a network error occurred", 3: "the file is corrupt or uses an unsupported codec", 4: "this format/codec isn't supported by your browser" };
  warn(`<strong>Playback error:</strong> ${err ? (codes[err.code] || "playback failed") : "playback failed"}. Try VLC for full compatibility with unusual codecs.`);
});
els.video.addEventListener("timeupdate", () => {
  if (!els.video.duration) return;
  els.seek.value = (els.video.currentTime / els.video.duration) * 100;
  els.cur.textContent = fmtTime(els.video.currentTime);
  els.total.textContent = fmtTime(els.video.duration);
});
els.seek.addEventListener("input", () => { if (els.video.duration) els.video.currentTime = (els.seek.value / 100) * els.video.duration; });

[els.videoList, els.m4aList].forEach(list => list.addEventListener("click", (e) => {
  const row = e.target.closest(".vp-row");
  if (row) playId(row.dataset.id);
}));

/* ---------------------------------------------------------------------
   Search — filters both the Video Files and M4A Files lists live.
   --------------------------------------------------------------------- */
els.searchInput.addEventListener("input", () => {
  state.search = els.searchInput.value;
  els.searchWrap.classList.toggle("has-text", !!state.search);
  render();
});
els.searchClear.addEventListener("click", () => {
  state.search = ""; els.searchInput.value = "";
  els.searchWrap.classList.remove("has-text");
  render();
  els.searchInput.focus();
});
window.addEventListener("keydown", (e) => {
  // "/" focuses search, like most list-heavy web apps — but never steal it
  // from an input the person is already typing in.
  const tag = (e.target && e.target.tagName) || "";
  if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); els.searchInput.focus(); }
  else if (e.key === "Escape" && document.activeElement === els.searchInput && state.search) {
    state.search = ""; els.searchInput.value = ""; els.searchWrap.classList.remove("has-text"); render();
  }
});

/* ---------------------------------------------------------------------
   Subtitles — WebVTT via <track>, the one subtitle format every browser
   supports natively with no dependencies. SRT is auto-converted.
   --------------------------------------------------------------------- */
function srtToVtt(text) {
  let body = text.replace(/\r+/g, "").trim();
  // Strip a UTF-8 BOM if present.
  if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1);
  body = body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return "WEBVTT\n\n" + body + "\n";
}
function looksLikeVtt(text) { return /^\uFEFF?WEBVTT/.test(text.trim()); }

function clearSubtitle() {
  if (state.currentTrackEl) { state.currentTrackEl.remove(); state.currentTrackEl = null; }
  if (state.currentSubUrl) { URL.revokeObjectURL(state.currentSubUrl); state.currentSubUrl = null; }
  els.ccBtn.classList.remove("active-cc");
}

async function applySubtitleFromText(text, label) {
  clearSubtitle();
  const vttText = looksLikeVtt(text) ? text : srtToVtt(text);
  const blob = new Blob([vttText], { type: "text/vtt" });
  const url = URL.createObjectURL(blob);
  const track = document.createElement("track");
  track.kind = "subtitles"; track.label = label || "Subtitles"; track.srclang = "en"; track.default = true;
  track.src = url;
  els.video.appendChild(track);
  state.currentTrackEl = track; state.currentSubUrl = url;
  // Chrome/Firefox need the mode set explicitly after the track loads.
  track.addEventListener("load", () => { if (track.track) track.track.mode = "showing"; });
  setTimeout(() => { if (track.track) track.track.mode = "showing"; }, 150);
  els.ccBtn.classList.add("active-cc");
}

function findSiblingSubtitles(item) {
  const matches = state.subs.filter(s => s.folder === item.folder && s.base === item.base);
  // English first (if present), then other named languages alphabetically, then unlabeled tracks last.
  return matches.sort((a, b) => {
    if (a.lang === "English") return -1;
    if (b.lang === "English") return 1;
    if (a.lang && b.lang) return a.lang.localeCompare(b.lang);
    if (a.lang) return -1;
    if (b.lang) return 1;
    return a.name.localeCompare(b.name);
  });
}
function subtitleLabel(m) { return m.lang ? m.lang : m.name; }

async function autoLoadSiblingSubtitle(item) {
  state.subtitleMatches = findSiblingSubtitles(item);
  state.subtitleIndex = -1; // -1 = off
  if (!state.subtitleMatches.length) return;
  await selectSubtitleByIndex(0, true);
}

async function selectSubtitleByIndex(idx, silent) {
  const matches = state.subtitleMatches || [];
  if (idx < 0 || idx >= matches.length) {
    clearSubtitle();
    state.subtitleIndex = -1;
    if (!silent) toast("Subtitles: Off");
    return;
  }
  const m = matches[idx];
  const file = await getSubFile(m.id);
  if (!file) { toast("Couldn't read that subtitle file."); return; }
  const text = await file.text();
  await applySubtitleFromText(text, subtitleLabel(m));
  state.subtitleIndex = idx;
  if (!silent) toast(`Subtitles: ${subtitleLabel(m)}`);
}

/** VLC-style "V" key — cycles Off → each detected language → Off. */
function cycleSubtitleTrack() {
  const matches = state.subtitleMatches || [];
  if (!matches.length) { toast("No subtitles detected for this video."); return; }
  const next = (state.subtitleIndex + 1 >= matches.length) ? -1 : state.subtitleIndex + 1;
  selectSubtitleByIndex(next, false);
}

/* CC picker modal — shows every auto-detected language, click to display it immediately */
function openCcModal() {
  const matches = state.subtitleMatches || [];
  const rows = [];
  rows.push(`<div class="cc-row ${state.subtitleIndex === -1 ? "active" : ""}" data-action="off">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg> Off</div>`);
  matches.forEach((m, i) => rows.push(`<div class="cc-row ${state.subtitleIndex === i ? "active" : ""}" data-sub-idx="${i}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="20" height="14" rx="2"/></svg>
    ${escapeHtml(subtitleLabel(m))} ${m.lang ? `<span class="src-tag">${escapeHtml(m.name)}</span>` : `<span class="src-tag">detected</span>`}</div>`));
  if (!matches.length) rows.push(`<div class="cc-row" style="color:var(--text-muted);cursor:default;">No subtitles auto-detected for this video</div>`);
  els.ccList.innerHTML = rows.join("");
  els.ccModalOverlay.classList.add("open");
}
els.ccBtn.addEventListener("click", openCcModal);
els.ccCloseBtn.addEventListener("click", () => els.ccModalOverlay.classList.remove("open"));
els.ccModalOverlay.addEventListener("click", (e) => { if (e.target === els.ccModalOverlay) els.ccModalOverlay.classList.remove("open"); });
els.ccList.addEventListener("click", async (e) => {
  const off = e.target.closest('[data-action="off"]');
  if (off) { await selectSubtitleByIndex(-1, true); els.ccModalOverlay.classList.remove("open"); return; }
  const row = e.target.closest("[data-sub-idx]");
  if (row) { await selectSubtitleByIndex(Number(row.dataset.subIdx), true); els.ccModalOverlay.classList.remove("open"); }
});
els.ccLoadFileRow.addEventListener("click", () => { els.ccModalOverlay.classList.remove("open"); els.subtitleFileInput.click(); });
els.subtitleFileInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!SUB_EXT.test(file.name)) { toast("Please choose a .srt or .vtt file."); return; }
  const text = await file.text();
  await applySubtitleFromText(text, file.name);
  toast(`Loaded subtitles: ${file.name}`);
  e.target.value = "";
});

/* ---------------------------------------------------------------------
   Keyboard shortcuts — "V" cycles subtitle language tracks (Off → each
   detected language → Off), matching the same convention VLC uses.
   --------------------------------------------------------------------- */
window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "v" || e.key === "V") { e.preventDefault(); cycleSubtitleTrack(); }
});

/* ---------------------------------------------------------------------
   Custom accent colors — mirrors the picker in Settings on the main
   library page, so the CC/AUD buttons and active states here match.
   --------------------------------------------------------------------- */
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 201, g: 168, b: 76 };
}
function rgbToHex(r, g, b) { return "#" + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join(""); }
function shadeColor(hex, factor) { const { r, g, b } = hexToRgb(hex); return rgbToHex(r * factor, g * factor, b * factor); }
function rgbaStr(hex, alpha) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${alpha})`; }
async function applyStoredAccentColors() {
  const settings = await idbGet("kv", "settings");
  if (!settings) return;
  const root = document.documentElement.style;
  const a = settings.accentColor || "#C9A84C";
  const a2 = settings.accent2Color || "#B22222";
  root.setProperty("--accent", a);
  root.setProperty("--accent-dark", shadeColor(a, 0.68));
  root.setProperty("--accent-dim", rgbaStr(a, 0.33));
  root.setProperty("--ripple", rgbaStr(a, 0.13));
  root.setProperty("--accent2", a2);
  root.setProperty("--accent2-dim", rgbaStr(a2, 0.33));
  if (settings.light) document.documentElement.setAttribute("data-theme", "light");
}

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
async function boot() {
  await applyStoredAccentColors();
  const handle = await getStoredHandle();
  if (handle) {
    const granted = await verifyPermission(handle, false);
    if (granted) { state.usingFSApi = true; await scanHandle(handle); return; }
    els.grantBtn.textContent = "Resume Access to Videos";
    els.grantBtn.onclick = async () => {
      const ok = await verifyPermission(handle, true);
      if (ok) { state.usingFSApi = true; await scanHandle(handle); }
      else toast("Access wasn't granted.");
    };
  }
}
boot();
})();
