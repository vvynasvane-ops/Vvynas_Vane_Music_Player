/* =========================================================================
   VVYNAS VANE — RECAP
   Reads the monthStats IndexedDB store (written by app.js during playback)
   and renders a monthly or yearly listening recap, plus a downloadable
   poster image — a web port of RecapActivity.java.
   ========================================================================= */
(() => {
"use strict";
const { idbGetAllKeys, idbGet } = window.VV;

const MONTH_NAMES = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MOTIVATIONS = [
  "Every song was a step further into the story you're writing.",
  "The soundtrack of this month was entirely your own choosing.",
  "Some months are loud. Some are quiet. Yours had rhythm.",
  "You didn't just listen — you kept coming back. That's devotion.",
  "A year from now, this playlist will remember what today forgets.",
  "The best recaps aren't about numbers. They're about what you needed to hear.",
];

const state = { mode: "monthly", year: new Date().getFullYear(), month: new Date().getMonth(), monthData: {} };

const $ = (s) => document.querySelector(s);
const els = { content: $("#recapContent"), scroller: $("#monthScroller"), toggles: document.querySelectorAll(".toggle-btn"), downloadBtn: $("#downloadBtn") };

function key(y, m) { return `${y}-${String(m + 1).padStart(2, "0")}`; }
function fmtHMS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600), m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function loadAllStats() {
  const keys = await idbGetAllKeys("monthStats");
  const out = {};
  for (const k of keys) out[k] = await idbGet("monthStats", k);
  state.monthData = out;
}

function statsForMonth(y, m) {
  const rec = state.monthData[key(y, m)];
  if (!rec) return { seconds: 0, plays: 0, uniqueSongs: 0, top: null };
  const plays = Object.values(rec.plays || {}).reduce((a, b) => a + b, 0);
  const uniqueSongs = Object.keys(rec.plays || {}).length;
  let top = null, topCount = 0;
  for (const [id, count] of Object.entries(rec.plays || {})) if (count > topCount) { topCount = count; top = { ...rec.meta[id], count }; }
  return { seconds: rec.seconds || 0, plays, uniqueSongs, top };
}

function statsForYear(y) {
  let seconds = 0, plays = 0; const uniqueSet = new Set(); const songTotals = {}; const meta = {};
  const monthly = [];
  for (let m = 0; m < 12; m++) {
    const rec = state.monthData[key(y, m)];
    const monthPlays = rec ? Object.values(rec.plays || {}).reduce((a, b) => a + b, 0) : 0;
    monthly.push({ seconds: rec ? (rec.seconds || 0) : 0, plays: monthPlays });
    if (rec) {
      seconds += rec.seconds || 0;
      Object.entries(rec.plays || {}).forEach(([id, c]) => { uniqueSet.add(id); songTotals[id] = (songTotals[id] || 0) + c; meta[id] = rec.meta[id]; });
    }
  }
  plays = Object.values(songTotals).reduce((a, b) => a + b, 0);
  let top = null, topCount = 0;
  for (const [id, count] of Object.entries(songTotals)) if (count > topCount) { topCount = count; top = { ...meta[id], count }; }
  return { seconds, plays, uniqueSongs: uniqueSet.size, top, monthly };
}

function motivationFor(plays) {
  if (plays === 0) return "No songs played yet this period — once you do, this page comes alive.";
  return MOTIVATIONS[plays % MOTIVATIONS.length];
}

function renderMonthScroller() {
  els.scroller.innerHTML = MONTH_NAMES.map((n, i) => `<div class="month-chip ${i === state.month ? "active" : ""}" data-month="${i}">${n} ${state.year}</div>`).join("");
  document.getElementById("monthScrollerWrap").classList.toggle("hidden", state.mode !== "monthly");
}

function statRow(label, value, hi) { return `<div class="stat-row"><span class="lbl">${label}</span><span class="val ${hi ? "hi" : ""}">${value}</span></div>`; }

function renderMonthly() {
  const s = statsForMonth(state.year, state.month);
  if (s.plays === 0) {
    els.content.innerHTML = `<div class="empty">No listening recorded for ${MONTH_NAMES[state.month]} ${state.year} yet.<br>Play something from your library and come back.</div>`;
    return;
  }
  els.content.innerHTML = `
    <div class="card">
      <div class="card-label">${MONTH_NAMES[state.month]} ${state.year} — At a Glance</div>
      ${statRow("Listening time", fmtHMS(s.seconds))}
      ${statRow("Songs played", s.plays)}
      ${statRow("Unique tracks", s.uniqueSongs, true)}
    </div>
    ${s.top ? `<div class="card top-song-card">
      <div class="art"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/></svg></div>
      <div class="meta">
        <div class="t">${escapeHtml(s.top.title || "Unknown")}</div>
        <div class="a">${escapeHtml(s.top.artist || "")}</div>
        <div class="n">Played ${s.top.count}× this month — your top track</div>
      </div>
    </div>` : ""}
    <div class="motivation">${motivationFor(s.plays)}</div>
  `;
}

function renderYearly() {
  const s = statsForYear(state.year);
  if (s.plays === 0) {
    els.content.innerHTML = `<div class="empty">No listening recorded for ${state.year} yet.<br>Your yearly recap builds itself as you listen.</div>`;
    return;
  }
  const maxSec = Math.max(1, ...s.monthly.map(m => m.seconds));
  const bars = s.monthly.map((m, i) => `
    <div class="bar-col">
      <div class="bar" style="height:${Math.max(2, (m.seconds / maxSec) * 100)}%"></div>
      <div class="bar-label">${MONTH_NAMES[i][0]}</div>
    </div>`).join("");
  els.content.innerHTML = `
    <div class="card">
      <div class="card-label">${state.year} — Year In Review</div>
      ${statRow("Total listening time", fmtHMS(s.seconds))}
      ${statRow("Total songs played", s.plays)}
      ${statRow("Unique tracks", s.uniqueSongs, true)}
    </div>
    ${s.top ? `<div class="card top-song-card">
      <div class="art"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/></svg></div>
      <div class="meta">
        <div class="t">${escapeHtml(s.top.title || "Unknown")}</div>
        <div class="a">${escapeHtml(s.top.artist || "")}</div>
        <div class="n">Played ${s.top.count}× this year — your #1 track</div>
      </div>
    </div>` : ""}
    <div class="card">
      <div class="card-label">Month by Month</div>
      <div class="bar-chart">${bars}</div>
    </div>
    <div class="motivation">${motivationFor(s.plays)}</div>
  `;
}

function escapeHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function render() { renderMonthScroller(); if (state.mode === "monthly") renderMonthly(); else renderYearly(); }

els.toggles.forEach(btn => btn.addEventListener("click", () => {
  state.mode = btn.dataset.mode;
  els.toggles.forEach(b => b.classList.toggle("active", b === btn));
  render();
}));
els.scroller.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-month]");
  if (chip) { state.month = Number(chip.dataset.month); render(); }
});

/* ---------------------------------------------------------------------
   Downloadable poster — canvas-rendered 1080×1080 image, same purple
   starry identity as the page itself.
   --------------------------------------------------------------------- */
els.downloadBtn.addEventListener("click", () => {
  const canvas = document.getElementById("posterCanvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const s = state.mode === "monthly" ? statsForMonth(state.year, state.month) : statsForYear(state.year);
  const label = state.mode === "monthly" ? `${MONTH_NAMES[state.month]} ${state.year}` : `${state.year}`;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#05030D"); g.addColorStop(.5, "#0D0820"); g.addColorStop(1, "#150F35");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 200; i++) { const x = Math.random() * W, y = Math.random() * H * .7, r = Math.random() * 2 + .5;
    ctx.fillStyle = `rgba(255,255,255,${.3 + Math.random() * .6})`; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

  ctx.textAlign = "center";
  ctx.fillStyle = "#CC99FF"; ctx.font = "700 44px 'Courier New', monospace"; ctx.fillText("VVYNAS RECAP", W / 2, 140);
  ctx.fillStyle = "#8C7FB0"; ctx.font = "28px 'Courier New', monospace"; ctx.fillText(label, W / 2, 190);

  const stats = [["LISTENING TIME", fmtHMS(s.seconds)], ["SONGS PLAYED", String(s.plays)], ["UNIQUE TRACKS", String(s.uniqueSongs)]];
  let y0 = 320;
  stats.forEach(([lbl, val]) => {
    ctx.fillStyle = "#8C7FB0"; ctx.font = "22px 'Courier New', monospace"; ctx.fillText(lbl, W / 2, y0);
    ctx.fillStyle = "#F0E6FF"; ctx.font = "700 56px 'Courier New', monospace"; ctx.fillText(val, W / 2, y0 + 60);
    y0 += 140;
  });

  if (s.top) {
    ctx.fillStyle = "#FF8FCB"; ctx.font = "22px 'Courier New', monospace"; ctx.fillText("TOP TRACK", W / 2, y0 + 20);
    ctx.fillStyle = "#F0E6FF"; ctx.font = "700 32px 'Courier New', monospace"; ctx.fillText((s.top.title || "Unknown").slice(0, 30), W / 2, y0 + 70);
    ctx.fillStyle = "#8C7FB0"; ctx.font = "22px 'Courier New', monospace"; ctx.fillText((s.top.artist || "").slice(0, 34), W / 2, y0 + 105);
  }

  ctx.fillStyle = "#5C5080"; ctx.font = "18px 'Courier New', monospace"; ctx.fillText("VVYNAS VANE — MUSIC PLAYER", W / 2, H - 50);

  const link = document.createElement("a");
  link.download = `vvynas-recap-${state.mode === "monthly" ? key(state.year, state.month) : state.year}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
});

/* ---------------------------------------------------------------------
   Starfield backdrop
   --------------------------------------------------------------------- */
(function stars() {
  const canvas = document.getElementById("starsCanvas"), ctx = canvas.getContext("2d");
  let W, H, pts = [];
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; pts = Array.from({ length: 90 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.6 + .4, p: Math.random() * 6.28 })); }
  window.addEventListener("resize", resize); resize();
  let t = 0;
  function loop() { requestAnimationFrame(loop); t += .02; ctx.clearRect(0, 0, W, H);
    pts.forEach(pt => { const a = .3 + .5 * Math.abs(Math.sin(t + pt.p)); ctx.fillStyle = `rgba(230,220,255,${a})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2); ctx.fill(); }); }
  requestAnimationFrame(loop);
})();

async function boot() { await loadAllStats(); render(); }
boot();
})();
