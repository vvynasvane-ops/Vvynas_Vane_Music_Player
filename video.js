/* =========================================================================
   VVYNAS VANE — VIDEO PLAYER
   A simple, standard player for video (mp4/mkv/webm/mov/m4v) and M4A files.
   Deliberately undecorated — no animated theme, no page-turn transition.
   ========================================================================= */
(() => {
"use strict";
const { idbGet, idbSet, fsApiSupported, verifyPermission, pickDirectory, getStoredHandle, walkDirectory } = window.VV;

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi)$/i;
const M4A_EXT = /\.m4a$/i;
const ALL_EXT = /\.(mp4|mkv|webm|mov|m4v|avi|m4a)$/i;

const state = { videos: [], m4as: [], fileRefs: new Map(), queue: [], queueIndex: -1, usingFSApi: false, objectUrl: null };

const $ = (s) => document.querySelector(s);
const els = {
  grantSection: $("#grantSection"), grantBtn: $("#grantBtn"), playerSection: $("#playerSection"),
  scanningSection: $("#scanningSection"), scanningStatus: $("#scanningStatus"),
  vpStage: $("#vpStage"), vpEmptyStage: $("#vpEmptyStage"), video: $("#vpVideo"),
  title: $("#vpTitle"), sub: $("#vpSub"),
  prevBtn: $("#vpPrevBtn"), playBtn: $("#vpPlayBtn"), playIcon: $("#vpPlayIcon"), nextBtn: $("#vpNextBtn"),
  seek: $("#vpSeek"), cur: $("#vpCur"), total: $("#vpTotal"),
  videoList: $("#videoList"), m4aList: $("#m4aList"), videoLabel: $("#videoLabel"), m4aLabel: $("#m4aLabel"),
  backBtn: $("#backBtn"), fullscreenBtn: $("#fullscreenBtn"), folderFallback: $("#vpFolderFallback"),
  toast: $("#toast"),
};

function toast(msg) { els.toast.textContent = msg; els.toast.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => els.toast.classList.remove("show"), 2200); }
function fmtTime(sec) { if (!isFinite(sec) || sec < 0) sec = 0; const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, "0")}`; }
function escapeHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

els.backBtn.addEventListener("click", () => { window.location.href = "index.html"; });
els.fullscreenBtn.addEventListener("click", () => {
  if (els.video.requestFullscreen) els.video.requestFullscreen().catch(() => toast("Fullscreen not available."));
  else toast("Fullscreen not supported in this browser.");
});

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
  if (!files.length) { toast("No video or M4A files found."); return; }
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
  state.videos = []; state.m4as = []; state.fileRefs.clear();
  entries.forEach((e, i) => {
    const id = "v" + i + "_" + e.path.length;
    const name = e.path.split("/").pop();
    state.fileRefs.set(id, e.handle);
    const item = { id, name, path: e.path };
    if (M4A_EXT.test(name)) state.m4as.push(item); else state.videos.push(item);
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
    <span class="kind">${kind === "video" ? item.name.split(".").pop().toUpperCase() : "M4A"}</span>
  </div>`;
}

function render() {
  els.videoLabel.textContent = `Video Files (${state.videos.length})`;
  els.m4aLabel.textContent = `M4A Files (${state.m4as.length})`;
  els.videoList.innerHTML = state.videos.length
    ? state.videos.map(v => rowHtml(v, "video")).join("")
    : `<div style="padding:16px;color:var(--text-muted);font-size:13px;">No video files found.</div>`;
  els.m4aList.innerHTML = state.m4as.length
    ? state.m4as.map(v => rowHtml(v, "m4a")).join("")
    : `<div style="padding:16px;color:var(--text-muted);font-size:13px;">No M4A files found.</div>`;
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

async function playId(id) {
  const all = [...state.videos, ...state.m4as];
  state.queue = all.map(i => i.id);
  state.queueIndex = state.queue.indexOf(id);
  const item = all.find(i => i.id === id);
  const file = await getFile(id);
  if (!file) { toast("Couldn't read that file."); return; }
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  els.vpEmptyStage.classList.add("hidden");
  els.video.classList.remove("hidden");
  els.video.src = state.objectUrl;
  els.video.play().catch(() => {});
  els.title.textContent = item.name;
  els.sub.textContent = M4A_EXT.test(item.name) ? "Audio (M4A)" : "Video";
  render();
}

function togglePlay() { if (!els.video.src) return; if (els.video.paused) els.video.play(); else els.video.pause(); }
function next() { if (!state.queue.length) return; let i = state.queueIndex + 1; if (i >= state.queue.length) i = 0; playId(state.queue[i]); }
function prev() { if (!state.queue.length) return; let i = state.queueIndex - 1; if (i < 0) i = state.queue.length - 1; playId(state.queue[i]); }

els.playBtn.addEventListener("click", togglePlay);
els.nextBtn.addEventListener("click", next);
els.prevBtn.addEventListener("click", prev);
els.video.addEventListener("play", () => { els.playIcon.innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'; });
els.video.addEventListener("pause", () => { els.playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>'; });
els.video.addEventListener("ended", next);
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

async function boot() {
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
