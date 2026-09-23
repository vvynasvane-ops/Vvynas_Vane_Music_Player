/* =========================================================================
   VVYNAS VANE — LYRICS   (window.VaneLyrics)

   Where lyrics come from, in priority order (first hit wins):
     1. Lyrics you saved / imported / pasted yourself — or an online match
        you accepted (kept on-device in IndexedDB, works offline afterwards)
     2. A sidecar file next to the song:  "Song.mp3" + "Song.lrc" (or .txt)
     3. Lyrics embedded in the audio file's own tags
        (ID3v2 USLT / SYLT / TXXX, FLAC Vorbis comment, MP4 ©lyr)
     4. OPTIONAL online lookup on lrclib.net — off unless the person says so.
        Only title / artist / duration are sent; nothing else leaves the device.

   Synced (LRC) lyrics follow the song line by line with a per-word sweep,
   tap-to-seek, adjustable timing and text size; plain lyrics just scroll.
   Extras: lyric-card export (share/download a poster of any line), copy,
   a bass-reactive glow tied to the shared audio graph, and a teleprompter
   mode that scrolls unsynced lyrics with the song's progress.
   ========================================================================= */
(function (global) {
"use strict";

/* =====================================================================
   1. LRC / plain-text parsing
   ===================================================================== */
const TIME_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LEAD_TAGS = /^((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*)+)/;
const META_KEYS = new Set(["ar", "ti", "al", "au", "by", "re", "ve", "length", "offset", "la", "id", "lang", "tool", "language"]);

function tagSeconds(mm, ss, frac) {
  return Number(mm) * 60 + Number(ss) + (frac ? Number("0." + frac) : 0);
}

/** Parses LRC or plain text.
 *  → { synced, lines: [{ t: seconds|null, text }], meta } — a blank `text` marks an instrumental gap / stanza break. */
function parseLyrics(raw) {
  const text = String(raw == null ? "" : raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const meta = {}, timed = [], plain = [];
  for (const rl of text.split("\n")) {
    let rest = rl.trim();
    const lead = LEAD_TAGS.exec(rest);
    if (lead) {
      const times = [];
      for (const m of lead[1].matchAll(TIME_TAG)) times.push(tagSeconds(m[1], m[2], m[3]));
      rest = rest.slice(lead[1].length)
        .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "")   // enhanced-LRC word stamps
        .replace(TIME_TAG, "").replace(/\s+/g, " ").trim();
      times.forEach(t => timed.push({ t, text: rest }));
      plain.push({ t: null, text: rest });               // also kept for the unsynced fallback (e.g. a file with a single stamp)
      continue;
    }
    const md = /^\[([a-zA-Z#]+):(.*)\]$/.exec(rest);
    if (md && META_KEYS.has(md[1].toLowerCase())) { meta[md[1].toLowerCase()] = md[2].trim(); continue; }
    plain.push({ t: null, text: rest });
  }

  const nonBlankTimed = timed.filter(l => l.text).length;
  if (timed.length >= 2 && nonBlankTimed >= 1) {
    const off = parseInt(meta.offset, 10);
    const shift = isFinite(off) ? off / 1000 : 0;          // [offset:+500] = show lyrics 0.5 s sooner
    let lines = timed.map((l, i) => ({ t: Math.max(0, l.t - shift), text: l.text, i }))
      .sort((a, b) => a.t - b.t || a.i - b.i).map(({ t, text }) => ({ t, text }));
    const out = [];
    for (const l of lines) { if (!l.text && (!out.length || !out[out.length - 1].text)) continue; out.push(l); } // no leading / doubled gaps
    while (out.length && !out[out.length - 1].text) out.pop();
    return { synced: true, lines: out, meta };
  }
  // plain: collapse runs of blank lines to one stanza break, trim the ends
  const out = [];
  for (const l of plain) { if (!l.text && (!out.length || !out[out.length - 1].text)) continue; out.push(l); }
  while (out.length && !out[out.length - 1].text) out.pop();
  return { synced: false, lines: out, meta };
}

function toPlainText(parsed) {
  return parsed.lines.map(l => l.text).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function fmtStamp(sec) {
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return "[" + String(m).padStart(2, "0") + ":" + s.toFixed(2).padStart(5, "0") + "]";
}

/* =====================================================================
   2. Reading lyrics out of the audio file itself
   ===================================================================== */
const U8 = (buf) => (buf instanceof Uint8Array ? buf : new Uint8Array(buf));
const be32 = (b, p) => (b[p] * 0x1000000) + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
const le32 = (b, p) => (b[p + 3] * 0x1000000) + ((b[p + 2] << 16) | (b[p + 1] << 8) | b[p]);
const synchsafe = (b, p) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);
const ascii = (b, p, n) => { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + i]); return s; };
const utf8 = (b) => new TextDecoder("utf-8").decode(b);

function decodeID3Text(bytes, enc) {
  try {
    if (enc === 1) {
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
      if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
      return new TextDecoder("utf-16le").decode(bytes);
    }
    if (enc === 2) return new TextDecoder("utf-16be").decode(bytes);
    if (enc === 3) return utf8(bytes);
    return new TextDecoder("windows-1252").decode(bytes);
  } catch (e) { return ""; }
}
/** index of the terminator (1 or 2 zero bytes depending on encoding) at/after `from`, or -1 */
function findTerm(b, from, end, enc) {
  if (enc === 1 || enc === 2) { for (let i = from; i + 1 < end; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i; return -1; }
  for (let i = from; i < end; i++) if (b[i] === 0) return i;
  return -1;
}
function undoUnsync(b) {
  const out = new Uint8Array(b.length); let n = 0;
  for (let i = 0; i < b.length; i++) { out[n++] = b[i]; if (b[i] === 0xFF && b[i + 1] === 0x00) i++; }
  return out.subarray(0, n);
}

/** Frames we care about from an ID3v2 tag → { text?, syncedLrc? } */
function parseID3Lyrics(bytes) {
  bytes = U8(bytes);
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") return null;
  const major = bytes[3], flags = bytes[5];
  const tagSize = synchsafe(bytes, 6);
  let body = bytes.subarray(10, Math.min(bytes.length, 10 + tagSize));
  if ((flags & 0x80) && major < 4) body = undoUnsync(body);
  let pos = 0;
  if (flags & 0x40) { pos = major >= 4 ? synchsafe(body, 0) : be32(body, 0) + 4; }
  let uslt = null, sylt = null, txxx = null;
  while (pos + (major === 2 ? 6 : 10) <= body.length) {
    let id, size, hdr, fflags = 0;
    if (major === 2) { id = ascii(body, pos, 3); size = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5]; hdr = 6; }
    else { id = ascii(body, pos, 4); size = major >= 4 ? synchsafe(body, pos + 4) : be32(body, pos + 4); fflags = (body[pos + 8] << 8) | body[pos + 9]; hdr = 10; }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || size <= 0) break;
    let start = pos + hdr, end = start + size;
    if (end > body.length) break;
    pos = end;
    if (!["USLT", "ULT", "SYLT", "SLT", "TXXX", "TXX"].includes(id)) continue;
    const compressed = major === 3 ? (fflags & 0x0080) : major >= 4 ? (fflags & 0x0008) : 0;
    const encrypted = major === 3 ? (fflags & 0x0040) : major >= 4 ? (fflags & 0x0004) : 0;
    if (compressed || encrypted) continue;
    let data = body.subarray(start, end);
    if (major === 3 && (fflags & 0x0020)) data = data.subarray(1);                  // grouping id
    if (major >= 4) {
      if (fflags & 0x0040) data = data.subarray(1);
      if (fflags & 0x0001) data = data.subarray(4);                                  // data-length indicator
      if ((fflags & 0x0002) || (flags & 0x80)) data = undoUnsync(data);
    }
    if (data.length < 5) continue;
    const enc = data[0];
    if (id === "USLT" || id === "ULT") {
      const d = findTerm(data, 4, data.length, enc); if (d < 0) continue;
      const t = decodeID3Text(data.subarray(d + (enc === 1 || enc === 2 ? 2 : 1)), enc).replace(/\0+$/g, "");
      if (t.trim() && !uslt) uslt = t;
    } else if (id === "SYLT" || id === "SLT") {
      const tsFormat = data[4]; if (tsFormat !== 2) continue;                        // only millisecond stamps
      const d = findTerm(data, 6, data.length, enc); if (d < 0) continue;
      let p = d + (enc === 1 || enc === 2 ? 2 : 1); const rows = [];
      while (p < data.length) {
        const te = findTerm(data, p, data.length, enc); if (te < 0) break;
        const txt = decodeID3Text(data.subarray(p, te), enc).replace(/^\n/, "");
        p = te + (enc === 1 || enc === 2 ? 2 : 1);
        if (p + 4 > data.length) break;
        rows.push({ t: be32(data, p) / 1000, text: txt.trim() }); p += 4;
      }
      if (rows.length >= 2 && !sylt) sylt = rows.map(r => fmtStamp(r.t) + r.text).join("\n");
    } else { // TXXX / TXX with a lyrics-ish description
      const d = findTerm(data, 1, data.length, enc); if (d < 0) continue;
      const desc = decodeID3Text(data.subarray(1, d), enc).trim();
      if (/^(un)?synced ?lyrics$|^lyrics(\b|[-_:])/i.test(desc)) {
        const t = decodeID3Text(data.subarray(d + (enc === 1 || enc === 2 ? 2 : 1)), enc).replace(/\0+$/g, "");
        if (t.trim() && !txxx) txxx = t;
      }
    }
  }
  // Prefer true synced data; a plain-text frame may itself be LRC, which parseLyrics detects.
  const text = sylt || uslt || txxx;
  return text ? { text } : null;
}

function parseFlacLyrics(bytes) {
  bytes = U8(bytes);
  if (ascii(bytes, 0, 4) !== "fLaC") return null;
  let pos = 4;
  while (pos + 4 <= bytes.length) {
    const h = bytes[pos], last = (h & 0x80) !== 0, type = h & 0x7f;
    const len = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const s = pos + 4; if (s + len > bytes.length) break;
    if (type === 4) {
      let p = s; const vlen = le32(bytes, p); p += 4 + vlen;
      const n = le32(bytes, p); p += 4;
      let found = null;
      for (let i = 0; i < n && p + 4 <= s + len; i++) {
        const l = le32(bytes, p); p += 4;
        const entry = utf8(bytes.subarray(p, p + l)); p += l;
        const eq = entry.indexOf("="); if (eq < 0) continue;
        const key = entry.slice(0, eq).toUpperCase(), val = entry.slice(eq + 1);
        if (/^(UN)?SYNCED ?LYRICS$|^LYRICS(-[A-Z]{3})?$/.test(key) && val.trim()) { if (key.startsWith("SYNCED") || !found) found = val; }
      }
      return found ? { text: found } : null;
    }
    pos = s + len; if (last) break;
  }
  return null;
}

/** Finds ©lyr inside a moov box already in memory. */
function findMp4Lyr(bytes) {
  bytes = U8(bytes);
  function walk(start, end) {
    let pos = start;
    while (pos + 8 <= end) {
      let size = be32(bytes, pos); const type = ascii(bytes, pos + 4, 4); let hdr = 8;
      if (size === 1) { size = be32(bytes, pos + 12); hdr = 16; }      // 64-bit size: low word is enough for boxes this small
      if (size === 0) size = end - pos;
      if (size < hdr || pos + size > end) break;
      const cs = pos + hdr, ce = pos + size;
      if (type === "moov" || type === "udta" || type === "ilst") { const f = walk(cs, ce); if (f) return f; }
      else if (type === "meta") { const f = walk(cs + 4, ce); if (f) return f; }
      else if (type === "\xA9lyr") {
        let dp = cs;
        while (dp + 16 <= ce) {
          const ds = be32(bytes, dp);
          if (ascii(bytes, dp + 4, 4) === "data" && ds > 16) { const t = utf8(bytes.subarray(dp + 16, dp + ds)); return t.trim() ? { text: t } : null; }
          if (ds < 8) break; dp += ds;
        }
      }
      pos += size;
    }
    return null;
  }
  return walk(0, bytes.length);
}

const READ_CAP = 24 * 1024 * 1024;
async function readSlice(file, a, b) { return new Uint8Array(await file.slice(a, b).arrayBuffer()); }

/** → { text } or null. Never throws. */
async function extractEmbeddedLyrics(file) {
  try {
    const head = await readSlice(file, 0, Math.min(file.size, 4096));
    const m3 = ascii(head, 0, 3), m4 = ascii(head, 0, 4);
    if (m3 === "ID3") {
      const total = 10 + synchsafe(head, 6);
      return parseID3Lyrics(await readSlice(file, 0, Math.min(file.size, total, READ_CAP)));
    }
    if (m4 === "fLaC") return parseFlacLyrics(await readSlice(file, 0, Math.min(file.size, READ_CAP)));
    if (ascii(head, 4, 4) === "ftyp") {
      // Walk top-level boxes by header only, so a trailing `moov` is found without reading the whole file.
      let pos = 0;
      while (pos + 8 <= file.size) {
        const h = await readSlice(file, pos, Math.min(file.size, pos + 16));
        let size = be32(h, 0); const type = ascii(h, 4, 4);
        if (size === 1) size = be32(h, 12);
        if (size === 0) size = file.size - pos;
        if (size < 8) break;
        if (type === "moov") { if (size > READ_CAP) return null; return findMp4Lyr(await readSlice(file, pos, pos + size)); }
        pos += size;
      }
    }
  } catch (e) { /* unreadable / unsupported tag → simply no embedded lyrics */ }
  return null;
}

/** UTF-8 first, then UTF-16 (BOM), then Windows-1252 — .lrc files from the wild use all of them. */
async function readTextFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.length > 2 * 1024 * 1024) throw new Error("file too large");
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder("windows-1252").decode(buf); }
}

/* =====================================================================
   3. Optional online lookup — LRCLIB (https://lrclib.net), free & open
   ===================================================================== */
function cleanTitle(t) {
  return String(t || "").replace(/\s*[\(\[][^\)\]]*(official|video|audio|lyrics?|lyric video|visuali[sz]er|hd|hq|remaster(ed)?|mv)[^\)\]]*[\)\]]/ig, "").replace(/\s+/g, " ").trim();
}
const words = (s) => new Set(String(s || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean));
function jaccard(a, b) { if (!a.size || !b.size) return 0; let i = 0; a.forEach(w => { if (b.has(w)) i++; }); return i / (a.size + b.size - i); }

/** Scores raw LRCLIB rows against the song; returns usable candidates, best first. Pure → unit-testable. */
function rankCandidates(rows, song) {
  const tw = words(cleanTitle(song.title)), aw = words(song.artist && !/^unknown/i.test(song.artist) ? song.artist : "");
  const out = [];
  for (const r of rows || []) {
    if (!r || r.instrumental || !(r.syncedLyrics || r.plainLyrics)) continue;
    let score = r.syncedLyrics ? 3 : 0;
    if (song.duration > 0 && r.duration > 0) {
      const d = Math.abs(song.duration - r.duration);
      if (d > 15) continue;                                    // a different edit/version → its timings would be wrong
      score += d <= 2 ? 4 : d <= 5 ? 2 : 0.5;
    }
    const tsim = jaccard(tw, words(r.trackName || r.name));
    if (tw.size && tsim < 0.34) continue;                     // not really this song
    score += tsim * 3 + (aw.size ? jaccard(aw, words(r.artistName)) * 2 : 0);
    out.push({ id: r.id, title: r.trackName || r.name || "", artist: r.artistName || "", album: r.albumName || "", duration: r.duration || 0, synced: r.syncedLyrics || "", plain: r.plainLyrics || "", score });
  }
  return out.sort((x, y) => y.score - x.score);
}

async function fetchLrclib(song, signal) {
  const enc = encodeURIComponent, title = cleanTitle(song.title);
  const artist = song.artist && !/^unknown/i.test(song.artist) ? song.artist : "";
  const queries = [];
  if (artist) queries.push("track_name=" + enc(title) + "&artist_name=" + enc(artist));
  queries.push("q=" + enc((artist ? artist + " " : "") + title));
  if (artist) queries.push("q=" + enc(title));
  let best = [];
  for (const q of queries) {
    const res = await fetch("https://lrclib.net/api/search?" + q, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) { if (res.status >= 500) throw new Error("server " + res.status); continue; }
    const cands = rankCandidates(await res.json(), song);
    if (cands.length) { best = cands; break; }
  }
  return best;
}

/* =====================================================================
   4. The lyrics view
   ===================================================================== */
const S = {
  open: false, song: null, parsed: null, source: "", lines: [], els: [], synced: false, active: -1, wordsEl: null,
  follow: true, followTimer: 0, shift: 0, token: 0, dirty: true, pickMode: false, candidates: [], candIdx: 0, raf: 0, opener: null,
  saved: false, lastWordKey: "",
};
const prefs = { size: 1, autoOnline: false, consent: false, teleprompter: false };
let B = null;          // bridge to app.js
let $ = {};            // elements
const SOURCE_LABEL = { saved: "Your lyrics", online: "LRCLIB", file: "Lyrics file", tag: "Embedded" };
const reduceMotion = () => !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
const kv = {
  get: (k) => global.VV.idbGet("kv", k).catch(() => undefined),
  set: (k, v) => global.VV.idbSet("kv", k, v).catch(() => {}),
  del: (k) => global.VV.idbDelete("kv", k).catch(() => {}),
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function toast(m, ms) { if (B && B.toast) B.toast(m, ms); }
function savePrefs() { kv.set("lyricsPrefs", prefs); }

/* ---- rendering ---- */
function setView(mode, msg) {          // "lines" | "empty" | "loading"
  $.lines.classList.toggle("hidden", mode !== "lines");
  $.empty.classList.toggle("hidden", mode !== "empty");
  $.loading.classList.toggle("hidden", mode !== "loading");
  if (mode === "empty") $.emptyMsg.textContent = msg || "";
  if (mode === "loading") $.loadingMsg.textContent = msg || "Looking for lyrics…";
  $.jump.classList.add("hidden");
}
function paintHeader(song) {
  $.title.textContent = song ? song.title : "Lyrics";
  $.artist.textContent = song ? song.artist : "";
  const art = song && B.art ? B.art(song) : "";
  $.backdrop.style.backgroundImage = art ? 'url("' + art + '")' : "none";
  $.total.textContent = fmt(B.audio.duration);
}
function fmt(sec) { if (!isFinite(sec) || sec < 0) sec = 0; const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return m + ":" + String(s).padStart(2, "0"); }

function renderLines(parsed, source) {
  S.parsed = parsed; S.source = source; S.lines = parsed.lines; S.synced = parsed.synced; S.active = -1; S.wordsEl = null; S.lastWordKey = "";
  $.lines.innerHTML = ""; S.els = [];
  const frag = document.createDocumentFragment();
  parsed.lines.forEach((l, i) => {
    const p = document.createElement("p");
    p.className = "ly-line" + (l.text ? "" : " ly-gap"); p.dataset.i = String(i);
    p.textContent = l.text || (parsed.synced ? "♪" : "");
    if (parsed.synced) p.dataset.d = "9";
    frag.appendChild(p); S.els.push(p);
  });
  $.lines.appendChild(frag);
  $.lines.classList.toggle("is-synced", parsed.synced);
  $.badge.textContent = (parsed.synced ? "Synced" : "Plain") + " · " + (SOURCE_LABEL[source] || source);
  $.badge.classList.toggle("synced", parsed.synced);
  $.scroll.scrollTop = 0;
  applySize(); refreshMenu(); setView("lines");
  S.follow = true;
  if (parsed.synced) { syncActive(true); }
}
function showEmpty(note) {
  S.parsed = null; S.lines = []; S.els = []; S.synced = false;
  $.badge.textContent = "No lyrics"; $.badge.classList.remove("synced");
  const has = !!S.song;
  $.emptyTitle.textContent = has ? "No lyrics for this song yet" : "Nothing playing";
  $.emptyBtns.classList.toggle("hidden", !has);
  setView("empty", note || (has ? "Add your own, import an .lrc file, or search the open lyrics database." : "Play a song, then come back for the words."));
  refreshMenu();
}
function applySize() { $.root.style.setProperty("--ly-size", String(prefs.size)); }

/* ---- loading pipeline ---- */
async function loadFor(song) {
  const token = ++S.token;
  S.song = song; S.dirty = false; S.candidates = []; S.candIdx = 0; S.pickMode = false; $.root.classList.remove("picking");
  paintHeader(song);
  if (!song) { showEmpty(); return; }
  setView("loading", "Looking for lyrics…");
  S.shift = Number(await kv.get("lyricsShift:" + song.id)) || 0;
  let found = null;
  const saved = await kv.get("lyrics:" + song.id);
  if (token !== S.token) return;
  S.saved = !!(saved && saved.text);
  if (S.saved) found = { text: saved.text, source: saved.source === "online" ? "online" : "saved" };
  if (!found && B.getLyricFile) {
    try { const f = await B.getLyricFile(song.id); if (f) { const t = await readTextFile(f); if (t.trim()) found = { text: t, source: "file" }; } } catch (e) { /* unreadable sidecar → keep looking */ }
    if (token !== S.token) return;
  }
  if (!found) {
    try {
      const f = await B.getFile(song.id);
      const emb = f && await extractEmbeddedLyrics(f);
      if (emb && emb.text) found = { text: emb.text, source: "tag" };
    } catch (e) { /* no embedded lyrics */ }
    if (token !== S.token) return;
  }
  if (found) {
    const parsed = parseLyrics(found.text);
    if (parsed.lines.length) { renderLines(parsed, found.source); return; }
  }
  if (prefs.autoOnline && prefs.consent) { searchOnline({ auto: true }); return; }
  showEmpty();
}

async function askConsent() {
  if (prefs.consent) return "always";
  return new Promise((resolve) => {
    $.dialog.classList.remove("hidden");
    const done = (v) => { $.dialog.classList.add("hidden"); $.dialogOnce.onclick = $.dialogAlways.onclick = $.dialogNo.onclick = null; resolve(v); };
    $.dialogOnce.onclick = () => done("once"); $.dialogAlways.onclick = () => done("always"); $.dialogNo.onclick = () => done(null);
    S.dialogCancel = () => done(null);
    $.dialogOnce.focus();
  });
}

async function searchOnline(opts) {
  opts = opts || {};
  const song = S.song; if (!song) return;
  if (!prefs.consent && !opts.consented) {
    const c = await askConsent(); S.dialogCancel = null;
    if (!c) return;
    if (c === "always") { prefs.consent = true; savePrefs(); refreshMenu(); }
  }
  if (!navigator.onLine) { toast("You're offline — can't search right now."); if (!S.parsed) showEmpty("You're offline. Try again when you're connected."); return; }
  const token = ++S.token; const keep = S.parsed;
  if (!keep) setView("loading", "Searching lrclib.net…"); else toast("Searching lrclib.net…", 1500);
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 9000);
  try {
    const cands = await fetchLrclib(song, ctl.signal);
    if (token !== S.token || S.song !== song) return;
    if (!cands.length) {
      if (keep) toast("No better match found online."); else showEmpty("Nothing close enough on LRCLIB. You can paste or import lyrics instead.");
      return;
    }
    S.candidates = cands; S.candIdx = 0;
    await applyCandidate(cands[0], !opts.auto);
  } catch (err) {
    if (token !== S.token) return;
    const msg = err && err.name === "AbortError" ? "The lyrics service took too long to answer." : "Couldn't reach lrclib.net.";
    if (keep) toast(msg); else showEmpty(msg + " Check your connection and try again.");
  } finally { clearTimeout(to); }
}
async function applyCandidate(c, announce) {
  const text = c.synced || c.plain;
  const parsed = parseLyrics(text);
  if (!parsed.lines.length) return;
  await kv.set("lyrics:" + S.song.id, { text, source: "online", meta: { id: c.id, title: c.title, artist: c.artist, album: c.album, duration: c.duration }, ts: Date.now() });
  S.saved = true;
  renderLines(parsed, "online");
  if (announce) toast((parsed.synced ? "Synced" : "Plain") + " lyrics found — " + c.artist + " · " + c.title, 2600);
}

/* ---- karaoke tracking ---- */
function findActive(tt) {
  const L = S.lines; let i = S.active;
  if (i < 0 && L.length && L[0].t > tt) return -1;
  if (i < 0) i = 0;
  while (i + 1 < L.length && L[i + 1].t <= tt) i++;
  while (i > 0 && L[i].t > tt) i--;
  if (i === 0 && L[0].t > tt) return -1;
  return i;
}
function setActive(idx, instant) {
  const prev = S.els[S.active];
  if (prev) { prev.classList.remove("active"); prev.removeAttribute("aria-current"); if (S.wordsEl === prev) { prev.textContent = S.lines[S.active].text || "♪"; S.wordsEl = null; } }
  S.active = idx; S.lastWordKey = "";
  for (let i = 0; i < S.els.length; i++) { const d = idx < 0 ? 9 : Math.min(9, Math.abs(i - idx)); const cur = S.els[i].dataset.d; if (cur !== String(d)) S.els[i].dataset.d = String(d); }
  const el = S.els[idx]; if (!el) return;
  el.classList.add("active"); el.setAttribute("aria-current", "true");
  if (S.lines[idx].text) buildWords(el, S.lines[idx].text);
  if (S.follow) centerOn(el, instant);
}
function buildWords(el, text) {
  el.textContent = ""; S.wordsEl = el;
  const parts = /\s/.test(text) ? text.split(/(\s+)/) : Array.from(text);
  parts.forEach(t => { if (!t) return; if (/^\s+$/.test(t)) el.appendChild(document.createTextNode(" ")); else { const w = document.createElement("span"); w.className = "w"; w.textContent = t; el.appendChild(w); } });
}
function centerOn(el, instant) {
  const top = el.offsetTop - $.scroll.clientHeight * 0.34 + el.offsetHeight / 2;
  $.scroll.scrollTo({ top: Math.max(0, top), behavior: instant || reduceMotion() ? "auto" : "smooth" });
}
function syncActive(instant) {
  if (!S.synced) return;
  const tt = B.audio.currentTime - S.shift;
  const idx = findActive(tt);
  if (idx !== S.active) setActive(idx, instant);
  updateWords(tt);
}
function updateWords(tt) {
  const el = S.wordsEl; if (!el || S.active < 0) return;
  const start = S.lines[S.active].t, next = S.lines[S.active + 1] ? S.lines[S.active + 1].t : start + 6;
  const text = S.lines[S.active].text;
  const dur = Math.min(next - start, Math.max(1.2, text.length * 0.085));   // sing-time, not the whole gap to the next line
  const p = clamp((tt - start) / dur, 0, 1);
  const ws = el.children, n = ws.length; if (!n) return;
  const k = p * n, whole = Math.floor(k), part = k - whole;
  const key = whole + ":" + Math.round(part * 12);
  if (key === S.lastWordKey) return; S.lastWordKey = key;
  for (let i = 0; i < n; i++) {
    const w = ws[i];
    w.className = i < whole ? "w on" : i === whole && p < 1 ? "w cur" : p >= 1 ? "w on" : "w";
    if (i === whole && p < 1) w.style.setProperty("--wp", (part * 100).toFixed(0) + "%"); else if (w.style.length) w.style.removeProperty("--wp");
  }
}

/* ---- follow / scroll handling ---- */
function userScrolled() {
  if (!S.follow) { armFollowTimer(); return; }
  S.follow = false; if (S.synced) $.jump.classList.remove("hidden"); armFollowTimer();
}
function armFollowTimer() { clearTimeout(S.followTimer); S.followTimer = setTimeout(resumeFollow, 6500); }
function resumeFollow() {
  clearTimeout(S.followTimer); S.follow = true; $.jump.classList.add("hidden");
  const el = S.els[S.active]; if (el) centerOn(el);
}

/* ---- per-frame loop ---- */
function tick() {
  if (!S.open) { S.raf = 0; return; }
  const a = B.audio, dur = a.duration;
  if (isFinite(dur) && dur > 0) $.seekFill.style.width = (a.currentTime / dur * 100) + "%";
  $.cur.textContent = fmt(a.currentTime);
  if (S.synced) syncActive();
  else if (prefs.teleprompter && S.follow && isFinite(dur) && dur > 0) {
    const max = $.scroll.scrollHeight - $.scroll.clientHeight, want = max * (a.currentTime / dur);
    if (Math.abs($.scroll.scrollTop - want) > 1) $.scroll.scrollTop += (want - $.scroll.scrollTop) * 0.12;
  }
  if (!a.paused && !reduceMotion() && global.VaneEQ) $.root.style.setProperty("--ly-beat", global.VaneEQ.beat().toFixed(3));
  S.raf = requestAnimationFrame(tick);
}

/* ---- open / close ---- */
function open(opener) {
  S.open = true; S.opener = opener || document.activeElement;
  $.root.classList.add("open"); $.root.setAttribute("aria-hidden", "false");
  const song = B.getSong();
  if (S.dirty || (song && (!S.song || S.song.id !== song.id)) || (!song && S.song)) loadFor(song);
  else paintHeader(S.song);
  updatePlayIcon();
  if (!S.raf) S.raf = requestAnimationFrame(tick);
  setTimeout(() => $.closeBtn.focus({ preventScroll: true }), 30);
}
function close() {
  S.open = false; S.pickMode = false; $.root.classList.remove("open", "picking"); $.root.setAttribute("aria-hidden", "true");
  closeMenu(); hideEditor(); $.dialog.classList.add("hidden");
  const o = S.opener; S.opener = null; if (o && o.focus && document.contains(o)) try { o.focus({ preventScroll: true }); } catch (e) {}
}
function songChanged() {
  if (S.open) loadFor(B.getSong()); else S.dirty = true;
}
function updatePlayIcon() {
  const playing = !B.audio.paused;
  $.play.classList.toggle("is-playing", playing);
  $.play.setAttribute("aria-label", playing ? "Pause" : "Play");
}

/* ---- menu ---- */
function openMenu() { refreshMenu(); $.menu.classList.remove("hidden"); $.menuBtn.setAttribute("aria-expanded", "true"); const f = $.menu.querySelector("button"); f && f.focus(); }
function closeMenu() { $.menu.classList.add("hidden"); $.menuBtn.setAttribute("aria-expanded", "false"); }
function refreshMenu() {
  if (!$.menu) return;
  $.menu.querySelector('[data-act="another"]').classList.toggle("hidden", S.candidates.length < 2);
  $.menu.querySelector('[data-act="remove"]').classList.toggle("hidden", !S.saved);
  $.menu.querySelector('[data-act="tele"]').setAttribute("aria-checked", String(prefs.teleprompter));
  $.menu.querySelector('[data-act="auto"]').setAttribute("aria-checked", String(prefs.autoOnline && prefs.consent));
  $.menu.querySelector('[data-act="card"]').classList.toggle("hidden", !S.lines.length);
  $.menu.querySelector('[data-act="copy"]').classList.toggle("hidden", !S.lines.length);
  $.menu.querySelector(".ly-shift-val").textContent = (S.shift > 0 ? "+" : S.shift < 0 ? "−" : "") + Math.abs(S.shift).toFixed(1) + "s";
  $.menu.querySelector(".ly-size-val").textContent = Math.round(prefs.size * 100) + "%";
  $.menu.querySelector(".ly-shift-row").classList.toggle("hidden", !S.synced);
}
async function menuAct(act) {
  switch (act) {
    case "search": closeMenu(); return searchOnline({ manual: true });
    case "another": {
      closeMenu(); if (S.candidates.length < 2) return;
      S.candIdx = (S.candIdx + 1) % S.candidates.length;
      await applyCandidate(S.candidates[S.candIdx], false);
      toast("Match " + (S.candIdx + 1) + " of " + S.candidates.length + " — " + S.candidates[S.candIdx].artist); return;
    }
    case "edit": closeMenu(); return showEditor();
    case "import": closeMenu(); $.file.value = ""; $.file.click(); return;
    case "card": closeMenu(); S.pickMode = true; $.root.classList.add("picking"); toast("Tap the line you want on your card", 3000); return;
    case "copy": {
      closeMenu(); const t = toPlainText(S.parsed);
      try { await navigator.clipboard.writeText(t); toast("Lyrics copied"); } catch (e) { toast("Couldn't copy — your browser blocked it."); }
      return;
    }
    case "shift-": case "shift+": {
      S.shift = Math.round((S.shift + (act === "shift+" ? 0.1 : -0.1)) * 10) / 10; S.shift = clamp(S.shift, -10, 10);
      if (Math.abs(S.shift) < 0.05) { S.shift = 0; kv.del("lyricsShift:" + S.song.id); } else kv.set("lyricsShift:" + S.song.id, S.shift);
      refreshMenu(); syncActive(true); return;
    }
    case "size-": case "size+": {
      prefs.size = clamp(Math.round((prefs.size + (act === "size+" ? 0.1 : -0.1)) * 10) / 10, 0.8, 1.8);
      savePrefs(); applySize(); refreshMenu(); const el = S.els[S.active]; if (el && S.follow) centerOn(el, true); return;
    }
    case "tele": prefs.teleprompter = !prefs.teleprompter; savePrefs(); refreshMenu(); toast(prefs.teleprompter ? "Unsynced lyrics will scroll with the song" : "Teleprompter off"); return;
    case "auto": {
      if (!(prefs.autoOnline && prefs.consent)) {
        closeMenu(); const c = await askConsent(); S.dialogCancel = null;
        if (c === "always") { prefs.consent = true; prefs.autoOnline = true; savePrefs(); toast("Will search LRCLIB when a song has no lyrics"); if (!S.parsed) searchOnline({ auto: true }); }
        else if (c === "once") searchOnline({ manual: true, consented: true });
      } else { prefs.autoOnline = false; savePrefs(); toast("Automatic online search off"); }
      refreshMenu(); return;
    }
    case "remove": {
      closeMenu(); await kv.del("lyrics:" + S.song.id); await kv.del("lyricsShift:" + S.song.id);
      S.saved = false; toast("Removed your saved lyrics"); return loadFor(S.song);
    }
  }
}

/* ---- editor ---- */
function showEditor() {
  kv.get("lyrics:" + S.song.id).then((rec) => {
    $.editText.value = rec && rec.text ? rec.text : (S.parsed ? (S.synced ? S.lines.map(l => fmtStamp(l.t) + l.text).join("\n") : toPlainText(S.parsed)) : "");
    $.editor.classList.remove("hidden"); $.editText.focus();
  });
}
function hideEditor() { if ($.editor) $.editor.classList.add("hidden"); }
async function saveEditor() {
  const text = $.editText.value.trim(); const song = S.song; if (!song) return;
  hideEditor();
  if (!text) { await kv.del("lyrics:" + song.id); S.saved = false; toast("Cleared"); return loadFor(song); }
  const parsed = parseLyrics(text);
  if (!parsed.lines.length) { toast("Nothing to save."); return; }
  await kv.set("lyrics:" + song.id, { text, source: "user", ts: Date.now() });
  S.saved = true; renderLines(parsed, "saved"); toast(parsed.synced ? "Saved — synced lyrics" : "Saved");
}
async function importFile(file) {
  if (!file || !S.song) return;
  try {
    const text = await readTextFile(file);
    if (!parseLyrics(text).lines.length) { toast("That file has no lyrics in it."); return; }
    $.editText.value = text; $.editor.classList.remove("hidden"); toast("Review it, then Save");
  } catch (e) { toast("Couldn't read that file."); }
}

/* ---- lyric card (share / download a poster of a line) ---- */
async function makeCard(index) {
  const song = S.song; if (!song) return;
  let text = S.lines[index].text; if (!text) return;
  const next = S.lines[index + 1];
  if (text.length < 32 && next && next.text) text += "\n" + next.text;
  const W = 1080, H = 1350, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const x = cv.getContext("2d");
  const cs = getComputedStyle($.root), accent = (cs.getPropertyValue("--accent") || "#C9A84C").trim();
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  const artUrl = B.art(song);
  const img = !artUrl ? null : await new Promise((res) => {
    const im = new Image(); let done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } };
    im.onload = () => finish(im); im.onerror = () => finish(null);
    im.src = artUrl;
    setTimeout(() => finish(null), 2500);   // a slow/broken image shouldn't block the card forever
  });
  x.fillStyle = "#0a0806"; x.fillRect(0, 0, W, H);
  if (img) {                                            // "blur" without ctx.filter (unsupported on older Safari): shrink hard, scale back up
    const t = document.createElement("canvas"); t.width = 24; t.height = 30; t.getContext("2d").drawImage(img, 0, 0, 24, 30);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high"; x.drawImage(t, -60, -60, W + 120, H + 120);
  }
  const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "rgba(0,0,0,.35)"); g.addColorStop(.5, "rgba(0,0,0,.55)"); g.addColorStop(1, "rgba(0,0,0,.85)");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // cover + song info
  const cvSize = 190, cx0 = 90, cy0 = 96;
  if (img) { x.save(); x.beginPath(); x.roundRect ? x.roundRect(cx0, cy0, cvSize, cvSize, 22) : x.rect(cx0, cy0, cvSize, cvSize); x.clip(); x.drawImage(img, cx0, cy0, cvSize, cvSize); x.restore(); }
  x.textAlign = "left"; x.textBaseline = "alphabetic"; x.fillStyle = "#fff";
  x.font = "700 44px " + family; x.fillText(fit(x, song.title, 640), cx0 + cvSize + 36, cy0 + 86);
  x.fillStyle = accent; x.font = "400 34px " + family; x.fillText(fit(x, song.artist, 640), cx0 + cvSize + 36, cy0 + 142);
  // the line itself — shrink until it fits in ≤ 7 wrapped rows
  let size = 84, rows;
  for (; size >= 40; size -= 4) { x.font = "700 " + size + "px " + family; rows = wrap(x, text, W - 200); if (rows.length <= 7) break; }
  const lh = size * 1.28, total = rows.length * lh; let y = (H - total) / 2 + 60 + size * 0.85;
  x.textAlign = "center"; x.fillStyle = "#fff"; x.shadowColor = "rgba(0,0,0,.6)"; x.shadowBlur = 18;
  rows.forEach(r => { x.fillText(r, W / 2, y); y += lh; }); x.shadowBlur = 0;
  x.fillStyle = accent; x.fillRect(W / 2 - 46, H - 190, 92, 6);
  x.font = "400 30px " + family; x.fillStyle = "rgba(255,255,255,.75)"; x.fillText("Vvynas Vane", W / 2, H - 128);
  const blob = await new Promise(r => cv.toBlob(r, "image/png"));
  if (!blob) { toast("Couldn't make the card."); return; }
  const name = (song.artist + " - " + song.title).replace(/[\\/:*?"<>|]+/g, "") + " (lyric card).png";
  const file = new File([blob], name, { type: "image/png" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: song.title }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast("Lyric card saved");
}
function fit(ctx, s, maxW) { s = String(s || ""); if (ctx.measureText(s).width <= maxW) return s; while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1); return s + "…"; }
function wrap(ctx, text, maxW) {
  const rows = [];
  text.split("\n").forEach(par => {
    const parts = /\s/.test(par) ? par.split(/\s+/) : Array.from(par); const glue = /\s/.test(par) ? " " : "";
    let line = "";
    parts.forEach(w => { const t = line ? line + glue + w : w; if (ctx.measureText(t).width > maxW && line) { rows.push(line); line = w; } else line = t; });
    if (line) rows.push(line);
  });
  return rows;
}

/* ---- wiring ---- */
function init(bridge) {
  B = bridge;
  const g = (id) => document.getElementById(id);
  $ = { root: g("lyricsOverlay"), backdrop: g("lyBackdrop"), closeBtn: g("lyCloseBtn"), title: g("lyTitle"), artist: g("lyArtist"), badge: g("lyBadge"), menuBtn: g("lyMenuBtn"),
    scroll: g("lyScroll"), lines: g("lyLines"), jump: g("lyJump"), empty: g("lyEmpty"), emptyTitle: g("lyEmptyTitle"), emptyMsg: g("lyEmptyMsg"), emptyBtns: g("lyEmptyBtns"),
    loading: g("lyLoading"), loadingMsg: g("lyLoadingMsg"), menu: g("lyMenu"), editor: g("lyEditor"), editText: g("lyEditText"), file: g("lyFileInput"),
    dialog: g("lyDialog"), dialogOnce: g("lyDialogOnce"), dialogAlways: g("lyDialogAlways"), dialogNo: g("lyDialogNo"),
    seek: g("lySeek"), seekFill: g("lySeekFill"), cur: g("lyCur"), total: g("lyTotal"), prev: g("lyPrev"), play: g("lyPlay"), next: g("lyNext") };
  if (!$.root) return;

  kv.get("lyricsPrefs").then((p) => { if (p && typeof p === "object") { prefs.size = clamp(Number(p.size) || 1, 0.8, 1.8); prefs.autoOnline = !!p.autoOnline; prefs.consent = !!p.consent; prefs.teleprompter = !!p.teleprompter; applySize(); } });

  $.closeBtn.addEventListener("click", close);
  $.menuBtn.addEventListener("click", (e) => { e.stopPropagation(); $.menu.classList.contains("hidden") ? openMenu() : closeMenu(); });
  $.menu.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b) { e.stopPropagation(); menuAct(b.dataset.act); } });
  document.addEventListener("pointerdown", (e) => { if (!$.menu.classList.contains("hidden") && !$.menu.contains(e.target) && e.target !== $.menuBtn && !$.menuBtn.contains(e.target)) closeMenu(); });
  g("lyEmptySearch").addEventListener("click", () => searchOnline({ manual: true }));
  g("lyEmptyPaste").addEventListener("click", showEditor);
  g("lyEmptyImport").addEventListener("click", () => { $.file.value = ""; $.file.click(); });
  $.file.addEventListener("change", () => importFile($.file.files[0]));
  g("lyEditSave").addEventListener("click", saveEditor);
  g("lyEditCancel").addEventListener("click", hideEditor);
  g("lyEditImport").addEventListener("click", () => { $.file.value = ""; $.file.click(); });
  g("lyEditClear").addEventListener("click", () => { $.editText.value = ""; $.editText.focus(); });
  $.jump.addEventListener("click", resumeFollow);
  ["wheel", "touchstart", "pointerdown"].forEach(ev => $.scroll.addEventListener(ev, (e) => { if (e.type === "pointerdown" && e.target.closest(".ly-line")) return; userScrolled(); }, { passive: true }));
  $.scroll.addEventListener("keydown", (e) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) { userScrolled(); e.stopPropagation(); } });
  $.lines.addEventListener("click", (e) => {
    const p = e.target.closest(".ly-line"); if (!p) return; const i = Number(p.dataset.i);
    if (S.pickMode) { S.pickMode = false; $.root.classList.remove("picking"); makeCard(i); return; }
    if (S.synced && isFinite(B.audio.duration)) {
      B.audio.currentTime = clamp(S.lines[i].t + S.shift, 0, B.audio.duration);
      S.follow = true; $.jump.classList.add("hidden"); syncActive(); if (B.audio.paused) B.togglePlay();
    }
  });
  // transport
  $.prev.addEventListener("click", () => B.prev()); $.next.addEventListener("click", () => B.next()); $.play.addEventListener("click", () => B.togglePlay());
  B.audio.addEventListener("play", updatePlayIcon); B.audio.addEventListener("pause", updatePlayIcon);
  B.audio.addEventListener("loadedmetadata", () => { if (S.open) $.total.textContent = fmt(B.audio.duration); });
  B.audio.addEventListener("seeked", () => { if (S.open && S.synced) syncActive(true); });
  const seekTo = (cx) => { const r = $.seek.getBoundingClientRect(); if (isFinite(B.audio.duration) && r.width) B.audio.currentTime = clamp((cx - r.left) / r.width, 0, 1) * B.audio.duration; };
  let dragging = false;
  $.seek.addEventListener("pointerdown", (e) => { dragging = true; try { $.seek.setPointerCapture(e.pointerId); } catch (x) {} seekTo(e.clientX); });
  $.seek.addEventListener("pointermove", (e) => { if (dragging) seekTo(e.clientX); });
  $.seek.addEventListener("pointerup", () => { dragging = false; }); $.seek.addEventListener("pointercancel", () => { dragging = false; });
  document.addEventListener("visibilitychange", () => { if (S.open && !document.hidden && !S.raf) S.raf = requestAnimationFrame(tick); });

  // Escape closes the innermost layer first, and never reaches the player underneath
  global.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !S.open) return;
    if (global.VaneEQ && global.VaneEQ.isOpen()) return;        // the EQ sits above us and handles its own Escape
    e.stopImmediatePropagation(); e.preventDefault();
    if (!$.dialog.classList.contains("hidden")) { if (S.dialogCancel) S.dialogCancel(); else $.dialog.classList.add("hidden"); }
    else if (!$.editor.classList.contains("hidden")) hideEditor();
    else if (!$.menu.classList.contains("hidden")) closeMenu();
    else if (S.pickMode) { S.pickMode = false; $.root.classList.remove("picking"); }
    else close();
  }, true);
  showEmpty();
}

global.VaneLyrics = {
  init, open, close, songChanged,
  toggle(opener) { S.open ? close() : open(opener); },
  isOpen() { return S.open; },
  _test: { parseLyrics, toPlainText, parseID3Lyrics, parseFlacLyrics, findMp4Lyr, extractEmbeddedLyrics, rankCandidates, cleanTitle, readTextFile, fmtStamp, wrap },
};
})(window);
