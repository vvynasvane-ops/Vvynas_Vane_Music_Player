/* =========================================================================
   VVYNAS VANE — SHARED ENGINE
   Used by index.html, video.html, and recap.html so storage access, the
   IndexedDB store, the 8-font system, and the animated backgrounds all stay
   in sync across pages of the app.
   ========================================================================= */
(function (global) {
"use strict";

/* ---------------------------------------------------------------------
   IndexedDB — shared store across every page
   --------------------------------------------------------------------- */
const DB_NAME = "vvynas-vane-db";
const DB_VERSION = 5;
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("playlists")) db.createObjectStore("playlists", { keyPath: "id" });
      if (!db.objectStoreNames.contains("favorites")) db.createObjectStore("favorites");
      if (!db.objectStoreNames.contains("playCounts")) db.createObjectStore("playCounts");
      if (!db.objectStoreNames.contains("monthStats")) db.createObjectStore("monthStats");
      if (!db.objectStoreNames.contains("djPlayCounts")) db.createObjectStore("djPlayCounts");
      // Per-song custom album art (Settings-free — set from the full
      // player's edit-art button). Key: song id. Value: a resized JPEG
      // data URL produced by resizeImageFileToDataUrl below.
      if (!db.objectStoreNames.contains("customArt")) db.createObjectStore("customArt");
      // Per-song embedded album art — extracted straight out of the audio
      // file's own tag (ID3v2 APIC, FLAC PICTURE block, or MP4 covr atom)
      // the first time that file's metadata is read. This is the song's
      // *own* cover, so it's the default shown any time there's no
      // user-uploaded custom photo. Key: song id. Value: resized JPEG
      // data URL, same normalized shape as customArt.
      if (!db.objectStoreNames.contains("embeddedArt")) db.createObjectStore("embeddedArt");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(store, "readonly"); const r = tx.objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function idbSet(store, key, value) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).delete(key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(store, "readonly"); const r = tx.objectStore(store).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
}
async function idbGetAllKeys(store) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(store, "readonly"); const r = tx.objectStore(store).getAllKeys(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
}
async function idbGetAllEntries(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const objStore = tx.objectStore(store);
    const out = [];
    const req = objStore.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { out.push([cur.key, cur.value]); cur.continue(); } else res(out);
    };
    req.onerror = () => rej(req.error);
  });
}
async function idbPut(store, obj) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(obj); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}

/* ---------------------------------------------------------------------
   Custom album art — takes a photo picked from device storage, at
   *any* resolution or aspect ratio, and normalizes it into a fixed
   512x512 JPEG data URL. Center-crops to a square first (like CSS
   object-fit: cover) so nothing gets stretched or letterboxed, then
   downscales, so the result is a consistent size/format that drops
   into every art call site — library rows, mini-player, full player,
   lock-screen artwork — exactly like generatedArt()'s output does.
   --------------------------------------------------------------------- */
async function loadImageBitmapFromFile(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch { /* fall through to <img> path below */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
    img.src = url;
  });
}
async function resizeImageFileToDataUrl(file, size = 512, quality = 0.86) {
  const bitmap = await loadImageBitmapFromFile(file);
  try {
    const srcW = bitmap.width, srcH = bitmap.height;
    const cropSize = Math.min(srcW, srcH);
    const sx = (srcW - cropSize) / 2, sy = (srcH - cropSize) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, sx, sy, cropSize, cropSize, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    if (bitmap.close) bitmap.close(); // only ImageBitmap has this, not the <img> fallback
  }
}

/* ---------------------------------------------------------------------
   Embedded album art — pulls the cover picture straight out of the song
   file's own tag, the same way every mainstream player does it, so a
   song shows its *real* artwork by default instead of a generated
   placeholder. Three well-established, self-contained (no CDN/library
   dependency, so it still works fully offline as an installed PWA)
   readers cover the formats this app already plays:
     - ID3v2 (mp3, and some m4a/wav): APIC frame (v2.3/2.4) or PIC (v2.2)
     - FLAC: METADATA_BLOCK_PICTURE (block type 6) in the header
     - MP4/M4A/AAC: the 'covr' atom under moov/udta/meta/ilst
   Only a bounded prefix (and, for MP4 only, the whole file if it's not
   too large) is ever read — never the entire library at once — so this
   stays cheap even for large lossless files.
   --------------------------------------------------------------------- */
const EMBED_SCAN_CAP = 20 * 1024 * 1024;   // read up to 20MB looking for tag headers
const MP4_FULL_SCAN_CAP = 80 * 1024 * 1024; // MP4 'moov' can trail the file; re-scan whole file up to this size

function bytesToStr(bytes, start, len) {
  let s = "";
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
function sniffImageMime(bytes, offset) {
  if (bytes[offset] === 0xFF && bytes[offset + 1] === 0xD8) return "image/jpeg";
  if (bytes[offset] === 0x89 && bytes[offset + 1] === 0x50) return "image/png";
  if (bytes[offset] === 0x47 && bytes[offset + 1] === 0x49) return "image/gif";
  return "image/jpeg";
}

/* ---- ID3v2 (APIC / PIC) ---- */
function parseID3v2Picture(bytes) {
  if (bytesToStr(bytes, 0, 3) !== "ID3") return null;
  const major = bytes[3];
  const flags = bytes[5];
  const synchsafe = (b0, b1, b2, b3) => ((b0 & 0x7f) << 21) | ((b1 & 0x7f) << 14) | ((b2 & 0x7f) << 7) | (b3 & 0x7f);
  const tagSize = synchsafe(bytes[6], bytes[7], bytes[8], bytes[9]);
  let pos = 10;
  if (flags & 0x40) { // extended header present
    const extSize = major >= 4 ? synchsafe(bytes[10], bytes[11], bytes[12], bytes[13]) : ((bytes[10] << 24) | (bytes[11] << 16) | (bytes[12] << 8) | bytes[13]);
    pos += extSize;
  }
  const end = Math.min(bytes.length, 10 + tagSize);
  while (pos < end - 10) {
    let id, size, frameHeaderLen;
    if (major === 2) {
      id = bytesToStr(bytes, pos, 3);
      size = (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5];
      frameHeaderLen = 6;
    } else {
      id = bytesToStr(bytes, pos, 4);
      size = major >= 4
        ? synchsafe(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
        : ((bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7]);
      frameHeaderLen = 10;
    }
    if (!id || size <= 0 || !/^[A-Z0-9]+$/.test(id)) break; // padding/garbage reached
    const dataStart = pos + frameHeaderLen;
    if (dataStart + size > bytes.length) break; // frame runs past what we read
    if (id === "APIC" || id === "PIC") {
      let p = dataStart;
      const encoding = bytes[p]; p += 1;
      let mime;
      if (id === "PIC") { mime = bytesToStr(bytes, p, 3); p += 3; if (/jpg|jpeg/i.test(mime)) mime = "image/jpeg"; else if (/png/i.test(mime)) mime = "image/png"; else mime = "image/jpeg"; }
      else {
        let mEnd = p; while (mEnd < dataStart + size && bytes[mEnd] !== 0) mEnd++;
        mime = bytesToStr(bytes, p, mEnd - p) || "image/jpeg";
        p = mEnd + 1;
      }
      p += 1; // picture type byte
      // skip null-terminated description (UTF-16 uses 2-byte terminator)
      if (encoding === 1 || encoding === 2) {
        while (p < dataStart + size - 1 && !(bytes[p] === 0 && bytes[p + 1] === 0)) p += 2;
        p += 2;
      } else {
        while (p < dataStart + size && bytes[p] !== 0) p++;
        p += 1;
      }
      const imgStart = p, imgEnd = dataStart + size;
      if (imgEnd > imgStart) return { mime: mime.startsWith("image/") ? mime : sniffImageMime(bytes, imgStart), bytes: bytes.slice(imgStart, imgEnd) };
    }
    pos = dataStart + size;
  }
  return null;
}

/* ---- FLAC (METADATA_BLOCK_PICTURE) ---- */
function parseFlacPicture(bytes) {
  if (bytesToStr(bytes, 0, 4) !== "fLaC") return null;
  let pos = 4;
  const readU32 = (p) => (bytes[p] * 0x1000000) + ((bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]);
  while (pos + 4 <= bytes.length) {
    const header = bytes[pos];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const blockStart = pos + 4;
    if (blockStart + len > bytes.length) break;
    if (type === 6) {
      let p = blockStart;
      p += 4; // picture type
      const mimeLen = readU32(p); p += 4;
      const mime = bytesToStr(bytes, p, mimeLen) || "image/jpeg"; p += mimeLen;
      const descLen = readU32(p); p += 4 + descLen;
      p += 16; // width, height, depth, colors (4 bytes each)
      const dataLen = readU32(p); p += 4;
      if (p + dataLen <= bytes.length) return { mime: mime.startsWith("image/") ? mime : sniffImageMime(bytes, p), bytes: bytes.slice(p, p + dataLen) };
      return null;
    }
    pos = blockStart + len;
    if (isLast) break;
  }
  return null;
}

/* ---- MP4/M4A ('covr' atom under moov/udta/meta/ilst) ---- */
function findMp4Covr(bytes) {
  const len = bytes.length;
  const readU32 = (p) => (bytes[p] * 0x1000000) + ((bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]);
  function walk(start, end, path) {
    let pos = start;
    while (pos + 8 <= end) {
      let size = readU32(pos);
      const type = bytesToStr(bytes, pos + 4, 4);
      let headerLen = 8;
      if (size === 1) { // 64-bit extended size — not expected for these small boxes, bail
        return null;
      }
      if (size === 0) size = end - pos; // box extends to end of parent
      if (size < 8 || pos + size > end) break;
      const childStart = pos + headerLen;
      const childEnd = pos + size;
      if (type === "moov" || type === "udta" || type === "ilst") {
        const found = walk(childStart, childEnd, path.concat(type));
        if (found) return found;
      } else if (type === "meta") {
        // 'meta' has a 4-byte version/flags field before its children
        const found = walk(childStart + 4, childEnd, path.concat(type));
        if (found) return found;
      } else if (type === "covr") {
        // 'covr' contains one or more 'data' boxes; take the first
        let dp = childStart;
        while (dp + 16 <= childEnd) {
          const dsize = readU32(dp);
          const dtype = bytesToStr(bytes, dp + 4, 4);
          if (dtype === "data" && dsize > 16) {
            const flagsByte = bytes[dp + 8 + 3]; // type indicator, low byte
            const dataStart = dp + 16, dataEnd = dp + dsize;
            const mime = flagsByte === 14 ? "image/png" : "image/jpeg";
            if (dataEnd <= childEnd) return { mime, bytes: bytes.slice(dataStart, dataEnd) };
          }
          if (dsize < 8) break;
          dp += dsize;
        }
      }
      pos += size;
    }
    return null;
  }
  return walk(0, len, []);
}

/** Reads just enough of a file to find its cover picture (if any),
 *  returning {mime, bytes:Uint8Array} or null. Never throws — any parse
 *  failure just means "no embedded art found", falling back later to a
 *  generated icon like before. */
async function extractRawPictureBlob(file) {
  try {
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 4096)).arrayBuffer());
    const magic4 = bytesToStr(head, 0, 4);
    if (magic4 === "ID3\x03" || magic4 === "ID3\x04" || magic4 === "ID3\x02" || bytesToStr(head, 0, 3) === "ID3") {
      const buf = new Uint8Array(await file.slice(0, Math.min(file.size, EMBED_SCAN_CAP)).arrayBuffer());
      return parseID3v2Picture(buf);
    }
    if (magic4 === "fLaC") {
      const buf = new Uint8Array(await file.slice(0, Math.min(file.size, EMBED_SCAN_CAP)).arrayBuffer());
      return parseFlacPicture(buf);
    }
    // MP4 family: 'ftyp' box normally sits right at the start (after a 4-byte size)
    const boxType = bytesToStr(head, 4, 4);
    if (boxType === "ftyp") {
      let buf = new Uint8Array(await file.slice(0, Math.min(file.size, EMBED_SCAN_CAP)).arrayBuffer());
      let found = findMp4Covr(buf);
      if (!found && file.size > buf.length && file.size <= MP4_FULL_SCAN_CAP) {
        // 'moov' (which holds the cover) sometimes trails after 'mdat' —
        // fall back to reading the whole file, but only if it's not huge.
        buf = new Uint8Array(await file.arrayBuffer());
        found = findMp4Covr(buf);
      }
      return found;
    }
  } catch { /* fall through — no embedded art */ }
  return null;
}

/** Full pipeline: extract the song's own embedded cover (if any) and
 *  normalize it into the same 512x512 JPEG data URL shape as
 *  resizeImageFileToDataUrl produces for user-uploaded photos, so it
 *  drops into every existing art call site unchanged. Returns null when
 *  the file has no readable embedded picture. */
async function getEmbeddedArtForFile(file) {
  const pic = await extractRawPictureBlob(file);
  if (!pic || !pic.bytes || !pic.bytes.length) return null;
  try {
    const blob = new Blob([pic.bytes], { type: pic.mime || "image/jpeg" });
    return await resizeImageFileToDataUrl(blob, 512, 0.86);
  } catch { return null; }
}

/* ---------------------------------------------------------------------
   Generated album art — shared so every page (library, DJ decks) renders
   the same deterministic art for the same song. Multiple hazard-themed
   styles are selectable in Settings; "sigil" (Westeros gold) is default.
   --------------------------------------------------------------------- */
const SIGIL_PALETTES = [
  ["#C9A84C", "#8A6E2A", "#1A1410"], ["#B22222", "#6b1414", "#1A1410"], ["#8B9CA8", "#3f4c55", "#110E0B"],
  ["#4A7C59", "#274430", "#110E0B"], ["#2E4A6A", "#182838", "#0A0806"], ["#CC5500", "#7a3300", "#1A1410"],
];
const artCache = new Map();
let currentArtStyle = "sigil";
function setArtStyle(style) { currentArtStyle = style; artCache.clear(); }
function getArtStyle() { return currentArtStyle; }
const ART_STYLES = [
  { id: "sigil", label: "Sigil (Default)" },
  { id: "skull", label: "Skeleton Hazard" },
  { id: "blood", label: "Vicious Blood" },
  { id: "biohazard", label: "Chernobyl Vybz" },
  { id: "gasmask", label: "Gas Mask" },
];
function hashStr(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; } return "s" + Math.abs(h).toString(36) + str.length.toString(36); }
function hashNum(seedStr) { return Math.abs(hashStr(seedStr).split("").reduce((a, c) => a + c.charCodeAt(0), 0)); }

function drawSigilArt(ctx, size, seedStr, h) {
  const pal = SIGIL_PALETTES[h % SIGIL_PALETTES.length];
  const grad = ctx.createRadialGradient(size * .5, size * .4, size * .05, size * .5, size * .5, size * .75);
  grad.addColorStop(0, pal[1]); grad.addColorStop(1, pal[2]);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = pal[0]; ctx.lineWidth = size * .02;
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size * .4, 0, Math.PI * 2); ctx.stroke();
  const rot = (h % 8) * (Math.PI / 16);
  ctx.save(); ctx.translate(size / 2, size / 2); ctx.rotate(rot); ctx.fillStyle = pal[0];
  const r2 = size * .24;
  ctx.beginPath(); ctx.moveTo(0, -r2); ctx.lineTo(r2 * .62, 0); ctx.lineTo(0, r2); ctx.lineTo(-r2 * .62, 0); ctx.closePath(); ctx.fill();
  ctx.restore();
  const letter = (seedStr.trim()[0] || "V").toUpperCase();
  ctx.fillStyle = pal[2]; ctx.font = `700 ${size * .16}px Cinzel, Georgia, serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(letter, size / 2, size / 2 + size * .01);
}

/** Reusable skull-with-eyeball-out icon, drawn centered at (cx,cy) with
 *  bone radius r. Shared by the album-art "Skeleton Hazard" style and
 *  Rage Mode's ambient background so both use the same realistic
 *  light/shadow model: a light source from upper-left (bone highlight),
 *  a shadow falloff to lower-right, and specular glints on the rounded
 *  eyeball/bone-knuckle surfaces to sell a wet/bone-glossy reflection. */
function drawSkullIcon(ctx, cx, cy, r, opts) {
  opts = opts || {};
  const alpha = opts.alpha !== undefined ? opts.alpha : 1;
  const poppedSide = opts.poppedSide || (Math.round(cx + cy) % 2 === 0 ? -1 : 1); // which socket has the eyeball hanging out
  ctx.save();
  ctx.globalAlpha = alpha;

  // --- lit bone gradient: bright upper-left, shadow lower-right ---
  const boneGrad = ctx.createLinearGradient(cx - r * .7, cy - r * .8, cx + r * .7, cy + r * .9);
  boneGrad.addColorStop(0, "#F5EFDD"); boneGrad.addColorStop(.45, "#DCD2B8"); boneGrad.addColorStop(1, "#7A705A");
  const boneShadow = "rgba(20,10,5,0.55)";

  // ambient contact shadow beneath the skull (grounds it / adds depth)
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.beginPath(); ctx.ellipse(cx, cy + r * 1.02, r * .62, r * .16, 0, 0, Math.PI * 2); ctx.fill();

  // cranium + cheek taper
  ctx.fillStyle = boneGrad;
  ctx.beginPath(); ctx.ellipse(cx, cy - r * .16, r * .62, r * .56, 0, Math.PI, 0); ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx - r * .62, cy - r * .16); ctx.lineTo(cx - r * .48, cy + r * .42);
  ctx.lineTo(cx + r * .48, cy + r * .42); ctx.lineTo(cx + r * .62, cy - r * .16); ctx.closePath(); ctx.fill();
  // shadow side (right hemisphere shaded darker, simple directional occlusion)
  ctx.fillStyle = boneShadow;
  ctx.beginPath(); ctx.ellipse(cx + r * .2, cy - r * .1, r * .42, r * .5, 0, -Math.PI * .5, Math.PI * .5); ctx.fill();

  // jaw
  const jawGrad = ctx.createLinearGradient(cx, cy + r * .3, cx, cy + r * .68);
  jawGrad.addColorStop(0, "#E4D9BE"); jawGrad.addColorStop(1, "#8C8064");
  ctx.fillStyle = jawGrad;
  const jw = r * .34, jh = r * .32, jx = cx - jw, jy = cy + r * .32;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(jx, jy, jw * 2, jh, r * .06); else ctx.rect(jx, jy, jw * 2, jh);
  ctx.fill();

  // sockets
  const socketR = r * .21;
  const leftX = cx - r * .26, rightX = cx + r * .26, socketY = cy - r * .06;
  function hollowSocket(sx, sy) {
    const sg = ctx.createRadialGradient(sx, sy, socketR * .1, sx, sy, socketR);
    sg.addColorStop(0, "#000000"); sg.addColorStop(.7, "rgba(90,0,0,0.9)"); sg.addColorStop(1, "rgba(40,0,0,0.6)");
    ctx.fillStyle = sg; ctx.beginPath(); ctx.ellipse(sx, sy, socketR, socketR * 1.15, 0, 0, Math.PI * 2); ctx.fill();
  }
  function specular(sx, sy, sr, rot) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath(); ctx.ellipse(sx, sy, sr, sr * .45, rot, 0, Math.PI * 2); ctx.fill();
  }
  function bloodshotEyeball(sx, sy, er) {
    // sclera
    const scleraGrad = ctx.createRadialGradient(sx - er * .3, sy - er * .3, er * .05, sx, sy, er);
    scleraGrad.addColorStop(0, "#FFF6F0"); scleraGrad.addColorStop(.8, "#E8CFC8"); scleraGrad.addColorStop(1, "#B99A93");
    ctx.fillStyle = scleraGrad; ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2); ctx.fill();
    // veins
    ctx.strokeStyle = "rgba(160,10,10,0.75)"; ctx.lineWidth = er * .06;
    for (let v = 0; v < 5; v++) { const a = (v / 5) * Math.PI * 2 + 0.4;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(sx + Math.cos(a) * er * .5, sy + Math.sin(a) * er * .5, sx + Math.cos(a) * er * .95, sy + Math.sin(a) * er * .95); ctx.stroke(); }
    // iris + pupil
    const irisGrad = ctx.createRadialGradient(sx, sy, er * .05, sx, sy, er * .48);
    irisGrad.addColorStop(0, "#6B3A1E"); irisGrad.addColorStop(1, "#2B1408");
    ctx.fillStyle = irisGrad; ctx.beginPath(); ctx.arc(sx, sy, er * .48, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#050202"; ctx.beginPath(); ctx.arc(sx, sy, er * .22, 0, Math.PI * 2); ctx.fill();
    // glossy specular reflection — the "light and dark reflection" on a wet surface
    specular(sx - er * .28, sy - er * .32, er * .22, -0.5);
  }

  // normal socket (opposite side from the popped eye)
  hollowSocket(poppedSide < 0 ? rightX : leftX, socketY);
  // deep glow at the back of the hollow socket
  ctx.fillStyle = "rgba(139,0,0,0.5)";
  const nsx = poppedSide < 0 ? rightX : leftX;
  ctx.beginPath(); ctx.ellipse(nsx, socketY, socketR * .55, socketR * .6, 0, 0, Math.PI * 2); ctx.fill();

  // popped-out socket: left empty/hollow here — the eyeball itself is
  // drawn last (after the jaw/teeth below) so it hangs in front of the
  // face rather than being occluded by it.
  const psx = poppedSide < 0 ? leftX : rightX;
  hollowSocket(psx, socketY);

  // nose cavity
  ctx.fillStyle = "#0A0000";
  ctx.beginPath(); ctx.moveTo(cx, cy + r * .1); ctx.lineTo(cx - r * .09, cy + r * .24); ctx.lineTo(cx + r * .09, cy + r * .24); ctx.closePath(); ctx.fill();

  // teeth (subtle light/shadow per tooth for a bit of relief)
  for (let t = -2; t <= 2; t++) {
    const tx = cx + t * r * .11;
    const tg = ctx.createLinearGradient(tx - r * .04, jy, tx + r * .04, jy);
    tg.addColorStop(0, "#F2EAD2"); tg.addColorStop(1, "#B7AC8C");
    ctx.fillStyle = tg; ctx.fillRect(tx - r * .045, jy + r * .02, r * .09, jh - r * .05);
    ctx.strokeStyle = "rgba(20,10,5,0.5)"; ctx.lineWidth = r * .01; ctx.strokeRect(tx - r * .045, jy + r * .02, r * .09, jh - r * .05);
  }

  // dangling optic nerve + bloodshot eyeball — drawn last so it hangs in
  // front of the jaw/teeth clear of the face, instead of behind it
  ctx.strokeStyle = "rgba(150,10,10,0.9)"; ctx.lineWidth = r * .045; ctx.lineCap = "round";
  const nerveEndY = jy + jh + r * .22;
  ctx.beginPath(); ctx.moveTo(psx, socketY + socketR * .3);
  ctx.quadraticCurveTo(psx + poppedSide * r * .1, cy + r * .5, psx + poppedSide * r * .02, nerveEndY - r * .12); ctx.stroke();
  ctx.lineCap = "butt";
  bloodshotEyeball(psx + poppedSide * r * .02, nerveEndY, r * .19);
  // a slow drip trailing from the dangling eyeball
  ctx.fillStyle = "rgba(120,0,0,0.75)";
  ctx.beginPath(); ctx.ellipse(psx + poppedSide * r * .02, nerveEndY + r * .27, r * .028, r * .06, 0, 0, Math.PI * 2); ctx.fill();

  // hairline crack for extra hazard grit
  ctx.strokeStyle = "rgba(30,15,10,0.5)"; ctx.lineWidth = r * .015;
  ctx.beginPath(); ctx.moveTo(cx + r * .12, cy - r * .55); ctx.lineTo(cx + r * .22, cy - r * .2); ctx.lineTo(cx + r * .14, cy + r * .02); ctx.stroke();

  // rim light along the top-left edge of the cranium (the "surface catching light" the user asked for)
  ctx.strokeStyle = "rgba(255,250,235,0.55)"; ctx.lineWidth = r * .035;
  ctx.beginPath(); ctx.arc(cx, cy - r * .16, r * .62, Math.PI * 1.05, Math.PI * 1.55); ctx.stroke();

  ctx.restore();
}

function drawSkullArt(ctx, size, h) {
  const bgPals = [["#120000", "#000000"], ["#0A0A0A", "#000000"], ["#1A0000", "#050000"]];
  const bg = bgPals[h % bgPals.length];
  const g = ctx.createRadialGradient(size * .5, size * .42, size * .04, size * .5, size * .5, size * .72);
  g.addColorStop(0, bg[0]); g.addColorStop(1, bg[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  // hazard-yellow warning ring
  ctx.strokeStyle = "#FFD400"; ctx.lineWidth = size * .028; ctx.setLineDash([size * .045, size * .035]);
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size * .43, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  drawSkullIcon(ctx, size * .5, size * .42, size * .3, { poppedSide: h % 2 === 0 ? -1 : 1 });
  // crossbones beneath
  ctx.strokeStyle = "#DCD2B8"; ctx.lineWidth = size * .045; ctx.lineCap = "round";
  const cx = size / 2, by = size * .8;
  ctx.beginPath(); ctx.moveTo(cx - size * .17, by - size * .1); ctx.lineTo(cx + size * .17, by + size * .1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx + size * .17, by - size * .1); ctx.lineTo(cx - size * .17, by + size * .1); ctx.stroke();
  ctx.lineCap = "butt";
}

function drawBloodArt(ctx, size, seedStr, h) {
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, "#150000"); g.addColorStop(.55, "#3A0000"); g.addColorStop(1, "#000000");
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const cx = size * .5, cy = size * .38;
  const splat = ctx.createRadialGradient(cx, cy, size * .02, cx, cy, size * .3);
  splat.addColorStop(0, "#C41E1E"); splat.addColorStop(.6, "#8B0000"); splat.addColorStop(1, "rgba(139,0,0,0)");
  ctx.fillStyle = splat; ctx.beginPath(); ctx.arc(cx, cy, size * .3, 0, Math.PI * 2); ctx.fill();
  // satellite splatter droplets
  const rnd = seededRand(h);
  ctx.fillStyle = "#8B0000";
  for (let i = 0; i < 9; i++) { const a = rnd() * Math.PI * 2, r = size * (.22 + rnd() * .22), dx = cx + Math.cos(a) * r, dy = cy + Math.sin(a) * r * .8, ds = size * (.015 + rnd() * .03);
    ctx.beginPath(); ctx.arc(dx, dy, ds, 0, Math.PI * 2); ctx.fill(); }
  // drips running down
  ctx.fillStyle = "#7A0000";
  for (let d = 0; d < 5; d++) { const dx = cx + (d - 2) * size * .09 + (rnd() - .5) * size * .04, topY = cy + size * .16, len = size * (.12 + rnd() * .22), w = size * (.02 + rnd() * .012);
    ctx.beginPath(); ctx.moveTo(dx - w, topY); ctx.lineTo(dx + w, topY);
    ctx.quadraticCurveTo(dx + w * .6, topY + len * .7, dx, topY + len); ctx.quadraticCurveTo(dx - w * .6, topY + len * .7, dx - w, topY); ctx.closePath(); ctx.fill(); }
  // bled-through initial
  const letter = (seedStr.trim()[0] || "V").toUpperCase();
  ctx.fillStyle = "rgba(255,80,80,0.9)"; ctx.font = `900 ${size * .22}px Georgia, serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(letter, cx, cy + size * .01);
  ctx.strokeStyle = "#4A0000"; ctx.lineWidth = size * .05;
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size * .47, 0, Math.PI * 2); ctx.stroke();
}

function drawBiohazardArt(ctx, size, h) {
  const g = ctx.createRadialGradient(size * .5, size * .5, size * .02, size * .5, size * .5, size * .7);
  g.addColorStop(0, "#0C1A00"); g.addColorStop(1, "#000500");
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  // toxic glow
  const glow = ctx.createRadialGradient(size * .5, size * .5, size * .05, size * .5, size * .5, size * .45);
  glow.addColorStop(0, "rgba(57,255,20,0.35)"); glow.addColorStop(1, "rgba(57,255,20,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, size, size);
  // hazard-yellow/black diagonal stripe ring border
  ctx.save(); ctx.beginPath(); ctx.arc(size / 2, size / 2, size * .46, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = "#1A1400"; ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#F2D000"; ctx.lineWidth = size * .05;
  for (let s = -size; s < size * 2; s += size * .14) { ctx.beginPath(); ctx.moveTo(s, size); ctx.lineTo(s + size, 0); ctx.stroke(); }
  ctx.restore();
  ctx.fillStyle = "#000000"; ctx.beginPath(); ctx.arc(size / 2, size / 2, size * .38, 0, Math.PI * 2); ctx.fill();
  // radiation trefoil — three blades rotated 120° apart
  const cx = size / 2, cy = size / 2, rot0 = (h % 12) * (Math.PI / 6);
  ctx.fillStyle = "#39FF14";
  ctx.beginPath(); ctx.arc(cx, cy, size * .06, 0, Math.PI * 2); ctx.fill();
  for (let b = 0; b < 3; b++) {
    const a0 = rot0 + b * (Math.PI * 2 / 3) - Math.PI / 6, a1 = rot0 + b * (Math.PI * 2 / 3) + Math.PI / 6;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, size * .06, a0, a1); ctx.lineTo(cx + Math.cos((a0 + a1) / 2) * size * .3, cy + Math.sin((a0 + a1) / 2) * size * .3);
    ctx.closePath();
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a0) * size * .06, cy + Math.sin(a0) * size * .06);
    ctx.arc(cx, cy, size * .3, a0, a1); ctx.arc(cx, cy, size * .06, a1, a0, true); ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = "#39FF14"; ctx.lineWidth = size * .012; ctx.beginPath(); ctx.arc(size / 2, size / 2, size * .38, 0, Math.PI * 2); ctx.stroke();
}

function drawGasMaskArt(ctx, size, h) {
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, "#141414"); g.addColorStop(1, "#000000");
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#F2D000"; ctx.lineWidth = size * .018; ctx.setLineDash([size * .03, size * .025]);
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size * .44, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  const cx = size / 2, cy = size * .48, rubber = "#262A26", rubberHi = "#3A403A";
  // face shell
  ctx.fillStyle = rubber;
  ctx.beginPath(); ctx.ellipse(cx, cy, size * .27, size * .3, 0, 0, Math.PI * 2); ctx.fill();
  // eye lenses
  const lensG = ctx.createRadialGradient(cx - size * .1, cy - size * .06, size * .01, cx - size * .1, cy - size * .02, size * .08);
  lensG.addColorStop(0, "#8FBF8F"); lensG.addColorStop(1, "#1A2A1A");
  ["l", "r"].forEach((side) => {
    const lx = side === "l" ? cx - size * .11 : cx + size * .11;
    ctx.fillStyle = "#0E120E"; ctx.beginPath(); ctx.arc(lx, cy - size * .03, size * .095, 0, Math.PI * 2); ctx.fill();
    const lg = ctx.createRadialGradient(lx - size * .02, cy - size * .06, size * .01, lx, cy - size * .03, size * .09);
    lg.addColorStop(0, "#7FAF7F"); lg.addColorStop(1, "#12200F");
    ctx.fillStyle = lg; ctx.beginPath(); ctx.arc(lx, cy - size * .03, size * .075, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = rubberHi; ctx.lineWidth = size * .018; ctx.beginPath(); ctx.arc(lx, cy - size * .03, size * .095, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.beginPath(); ctx.ellipse(lx - size * .025, cy - size * .07, size * .018, size * .01, -.4, 0, Math.PI * 2); ctx.fill();
  });
  // nose/filter bridge
  ctx.fillStyle = rubber; ctx.beginPath(); ctx.ellipse(cx, cy + size * .1, size * .06, size * .05, 0, 0, Math.PI * 2); ctx.fill();
  // filter canister (side, position varies by hash)
  const side = h % 2 === 0 ? 1 : -1, fx = cx + side * size * .27, fy = cy + size * .12;
  ctx.fillStyle = "#1C1E1C"; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(fx - size * .07, fy - size * .05, size * .14, size * .18, size * .03) : ctx.rect(fx - size * .07, fy - size * .05, size * .14, size * .18); ctx.fill();
  ctx.strokeStyle = "#F2D000"; ctx.lineWidth = size * .01;
  ctx.beginPath(); ctx.moveTo(fx - size * .07, fy + size * .03); ctx.lineTo(fx + size * .07, fy + size * .03); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(fx - size * .07, fy + size * .09); ctx.lineTo(fx + size * .07, fy + size * .09); ctx.stroke();
  // straps
  ctx.strokeStyle = rubberHi; ctx.lineWidth = size * .03;
  ctx.beginPath(); ctx.moveTo(cx - size * .26, cy - size * .12); ctx.quadraticCurveTo(cx, cy - size * .32, cx + size * .26, cy - size * .12); ctx.stroke();
}

function generatedArt(seedStr, size = 200, styleOverride) {
  const style = styleOverride || currentArtStyle;
  const key = style + "|" + seedStr + "@" + size;
  if (artCache.has(key)) return artCache.get(key);
  const canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  const h = hashNum(seedStr);
  if (style === "skull") drawSkullArt(ctx, size, h);
  else if (style === "blood") drawBloodArt(ctx, size, seedStr, h);
  else if (style === "biohazard") drawBiohazardArt(ctx, size, h);
  else if (style === "gasmask") drawGasMaskArt(ctx, size, h);
  else drawSigilArt(ctx, size, seedStr, h);
  const url = canvas.toDataURL("image/png");
  artCache.set(key, url);
  return url;
}

/* ---------------------------------------------------------------------
   Font Manager — mirrors FontManager.java's 8-entry matrix exactly
   (index 0 = Monospace = the app's real default, index/labels match 1:1)
   --------------------------------------------------------------------- */
const FONTS = [
  { id: 0, label: "MONOSPACE (DEFAULT)", stack: "'Courier New', ui-monospace, 'JetBrains Mono', monospace", weight: 400 },
  { id: 1, label: "SERIF",               stack: "Georgia, 'Times New Roman', serif",                        weight: 400 },
  { id: 2, label: "SANS-SERIF",          stack: "'Roboto', Arial, Helvetica, sans-serif",                   weight: 400 },
  { id: 3, label: "CONDENSED",           stack: "'Roboto Condensed', 'Arial Narrow', sans-serif",            weight: 400 },
  { id: 4, label: "SANS-SERIF LIGHT",    stack: "'Roboto', Arial, sans-serif",                               weight: 300 },
  { id: 5, label: "SANS-SERIF MEDIUM",   stack: "'Roboto', Arial, sans-serif",                               weight: 500 },
  { id: 6, label: "SANS-SERIF BLACK",    stack: "'Roboto', Arial, sans-serif",                               weight: 900 },
  { id: 7, label: "CASUAL",              stack: "'Comic Neue', 'Comic Sans MS', cursive",                    weight: 400 },
];
function applyFont(styleId) {
  const f = FONTS[styleId] || FONTS[0];
  document.documentElement.style.setProperty("--font-user", f.stack);
  document.documentElement.style.setProperty("--font-user-weight", String(f.weight));
  document.documentElement.setAttribute("data-font", String(f.id));
}

/* ---------------------------------------------------------------------
   Storage access — File System Access API with graceful fallback.
   Shared logic; callers supply their own file-extension filter.
   --------------------------------------------------------------------- */
function fsApiSupported() { return typeof window.showDirectoryPicker === "function"; }

async function verifyPermission(handle, requestIfNeeded) {
  const opts = { mode: "read" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if (requestIfNeeded && (await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

async function pickDirectory() {
  if (!fsApiSupported()) return null;
  try {
    const handle = await window.showDirectoryPicker({ mode: "read" });
    await idbSet("kv", "dirHandle", handle);
    return handle;
  } catch (err) {
    if (err && err.name === "AbortError") return null;
    throw err;
  }
}

async function getStoredHandle() { return idbGet("kv", "dirHandle"); }

/** Recursively walk a FileSystemDirectoryHandle, filtering by a RegExp test on filename. */
async function walkDirectory(dirHandle, extRegex, onProgress) {
  const found = [];
  async function walk(handle, path) {
    for await (const [name, entry] of handle.entries()) {
      const p = path ? `${path}/${name}` : name;
      if (entry.kind === "directory") await walk(entry, p);
      else if (entry.kind === "file" && extRegex.test(name)) {
        found.push({ handle: entry, path: p, folder: path || "Library Root" });
        if (onProgress) onProgress(found.length);
      }
    }
  }
  await walk(dirHandle, "");
  return found;
}

/* ---------------------------------------------------------------------
   Recognized audio file extensions — the single source of truth for
   which files count as "a song" anywhere files are scanned (main
   library folder scan, DJ Mode's folder scan, the <input webkitdirectory>
   fallback picker). Deliberately broad: covers every mainstream audio
   container/codec a user is likely to have on device, not just the
   handful iTunes/Spotify default to, so nothing gets silently skipped
   during a folder scan just because its extension wasn't on a short
   allowlist. Whether a given file then actually *plays* still depends on
   the browser/OS having a decoder for its codec — playSong below now
   catches that case and skips forward with a toast instead of just
   silently stalling. */
const AUDIO_EXT = /\.(mp3|mp2|m4a|m4b|m4p|m4r|aac|wav|wave|flac|ogg|oga|ogx|opus|weba|webm|wma|aiff|aif|aifc|amr|mka|caf|3gp|3g2|3ga|spx|ape|mpc|tta|wv|au|snd|mid|midi)$/i;

/* ---------------------------------------------------------------------
   Small canvas-drawing helpers mirroring the Android Canvas/Paint API
   used throughout AnimatedThemeView.java, so every theme below reads
   like a direct port of its Java counterpart.
   --------------------------------------------------------------------- */
function C(argb, aOverride) {
  const a = aOverride !== undefined ? aOverride : ((argb >>> 24) & 0xff) / 255;
  const r = (argb >> 16) & 0xff, g = (argb >> 8) & 0xff, b = argb & 0xff;
  return `rgba(${r},${g},${b},${a})`;
}
function linGrad(ctx, x0, y0, x1, y1, colors, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  colors.forEach((c, i) => g.addColorStop(stops ? stops[i] : i / Math.max(1, colors.length - 1), typeof c === "number" ? C(c) : c));
  return g;
}
function radGrad(ctx, cx, cy, r, colors, stops) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(0.01, r));
  colors.forEach((c, i) => g.addColorStop(stops ? stops[i] : i / Math.max(1, colors.length - 1), typeof c === "number" ? C(c) : c));
  return g;
}
function fillGrad(ctx, W, H, colors, stops) { ctx.fillStyle = linGrad(ctx, 0, 0, 0, H, colors, stops); ctx.fillRect(0, 0, W, H); }
function circle(ctx, x, y, r, fill) { ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2); if (fill) { ctx.fillStyle = fill; } ctx.fill(); }
function oval(ctx, x0, y0, x1, y1, fill) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, Math.PI * 2);
  if (fill) ctx.fillStyle = fill; ctx.fill();
}
function rect(ctx, x0, y0, x1, y1, fill) { if (fill) ctx.fillStyle = fill; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
function line(ctx, x0, y0, x1, y1, stroke, width) { ctx.strokeStyle = stroke; ctx.lineWidth = width || 1; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
function seededRand(seed) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }

/* ---------------------------------------------------------------------
   ThemeEngine — 42 backgrounds ported from AnimatedThemeView.java
   (theme 0 = "none"). Each theme keeps its own particle state in a
   closure, initialized lazily on first draw, exactly mirroring the
   Java view's per-theme init-on-first-use pattern.
   --------------------------------------------------------------------- */
const ThemeEngine = (function () {
  let canvas, ctx, W = 0, H = 0, tick = 0, raf = null, current = "none";
  const rnd = seededRand(42);

  const THEME_LIST = [
    { id: "none", label: "None" },
    { id: "waves", label: "Waves" }, { id: "volcano", label: "Volcano" }, { id: "sunset", label: "Sunset" },
    { id: "windmill", label: "Windmill" }, { id: "waterfall", label: "Waterfall" }, { id: "undersea", label: "Undersea" },
    { id: "smoke", label: "Smoke" }, { id: "piano", label: "Piano" }, { id: "thinking", label: "Thinking" },
    { id: "aurora", label: "Aurora" }, { id: "shark", label: "Shark" }, { id: "dog", label: "Dog" }, { id: "cat", label: "Cat" },
    { id: "sahara", label: "Sahara" }, { id: "darkness", label: "Darkness" }, { id: "letter", label: "Letter" },
    { id: "beach", label: "Beach" }, { id: "jamaica", label: "Jamaica" }, { id: "reggaeton", label: "Reggaeton" },
    { id: "firestorm", label: "Firestorm" }, { id: "galaxy", label: "Galaxy" }, { id: "zombie", label: "Zombie" },
    { id: "memoryLane", label: "Memory Lane" }, { id: "wildWest", label: "Wild West" }, { id: "fantasyIsland", label: "Fantasy Island" },
    { id: "arctic", label: "Arctic" }, { id: "tsunami", label: "Tsunami" }, { id: "thunderstorm", label: "Thunderstorm" },
    { id: "skydiving", label: "Skydiving" }, { id: "moonWalk", label: "Moon Walk" }, { id: "bar", label: "Bar" },
    { id: "fairytale", label: "Fairytale" }, { id: "witch", label: "Witch" }, { id: "romanceRnb", label: "Romance R&B" },
    { id: "hiphop", label: "Hip Hop" }, { id: "babylon", label: "Babylon" }, { id: "swordNight", label: "Sword Night" },
    { id: "drStrange", label: "Dr. Strange" }, { id: "lotr", label: "LOTR" }, { id: "arcane", label: "Arcane" },
    { id: "starWars", label: "Star Wars" },
  ];

  // ── generic particle field helper (embers / stars / bubbles / snow) ──
  function field(n) { const a = []; for (let i = 0; i < n; i++) a.push({}); return a; }

  // ═══ WAVES ═══
  function drawWaves() {
    fillGrad(ctx, W, H, [0xFF000814, 0xFF03045E, 0xFF0077B6, 0xFF00B4D8]);
    ctx.fillStyle = radGrad(ctx, W * .82, H * .12, H * .18, [0xAAFFFFFF, 0x44CCEEFF, 0x00000000]);
    circle(ctx, W * .82, H * .12, H * .18);
    const ampY = [.65, .70, .75, .80, .87], amps = [.06, .05, .04, .035, .025], spd = [1, .8, 1.2, .6, 1.4], freq = [2, 2.5, 1.8, 3, 2.2];
    const wc = [[0x3300B4D8, 0x5500B4D8], [0x440077B6, 0x660077B6], [0x5503045E, 0x7703045E], [0x6600FFD4, 0x8800FFD4], [0x8800B4D8, 0xAA00B4D8]];
    for (let w = 0; w < 5; w++) {
      const bY = H * ampY[w], amp = H * amps[w];
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 6) { const a = (x / W) * Math.PI * freq[w] + tick * spd[w]; ctx.lineTo(x, bY + Math.sin(a) * amp + Math.cos(a * .6) * amp * .4); }
      ctx.lineTo(W, H); ctx.closePath();
      ctx.fillStyle = linGrad(ctx, 0, bY - amp, 0, H, wc[w]); ctx.fill();
    }
    for (let i = 0; i < 30; i++) {
      const sx = (i * 127) % W, oy = H * ampY[4], sy = oy + Math.sin((sx / W) * Math.PI * 2.2 + tick * 1.4) * H * .025;
      circle(ctx, sx, sy, 2 + Math.sin(tick * 3 + i) * 1.5, C(0x99FFFFFF));
    }
  }

  // ═══ VOLCANO ═══
  let volcP;
  function drawVolcano() {
    fillGrad(ctx, W, H, [0xFF0A0005, 0xFF1A0010, 0xFF300000, 0xFF600000]);
    ctx.fillStyle = C(0xFF1A0A00);
    ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W * .15, H); ctx.lineTo(W * .5, H * .35); ctx.lineTo(W * .85, H); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = radGrad(ctx, W * .5, H * .35, W * .12, [0xFFFF6600, 0xAAFF2200, 0x00000000]);
    circle(ctx, W * .5, H * .35, W * .12);
    if (!volcP) { volcP = field(60).map(() => { const a = rnd() * Math.PI; return { x: W * .5 + Math.cos(a) * rnd() * W * .04, y: H * .35 - rnd() * H * .35, v: .5 + rnd() * 2.5, s: 2 + rnd() * 5, c: rnd() > .5 ? 0xFFFF6600 : 0xFFFF2200 }; }); }
    volcP.forEach((p, i) => { p.y -= p.v; p.x += Math.sin(tick + i) * 1.2; if (p.y < H * .05) { p.x = W * .5 + (rnd() - .5) * W * .12; p.y = H * .34; }
      const alpha = .6 + .4 * Math.sin(tick * 4 + i); circle(ctx, p.x, p.y, p.s, C(p.c, alpha)); });
    ctx.fillStyle = linGrad(ctx, 0, H * .82, 0, H, [0xFFFF4400, 0xFFFF8800, 0xFFFF2200]); rect(ctx, 0, H * .85, W, H);
    for (let i = 0; i < 5; i++) circle(ctx, W * (.1 + i * .2), H * .92, 8 + 6 * Math.sin(tick * 2 + i * 1.2), C(0x88FF8800));
  }

  // ═══ SUNSET ═══
  function drawSunset() {
    const sunY = H * (.35 + .05 * Math.sin(tick * .3));
    fillGrad(ctx, W, H, [0xFF0A0020, 0xFF2D1B69, 0xFFFF4E00, 0xFFFF8C00, 0xFFFFCC02, 0xFFFF6B35], [0, .25, .45, .6, .72, 1]);
    ctx.fillStyle = radGrad(ctx, W * .5, sunY, H * .14, [0xFFFFFFAA, 0xFFFFDD00, 0x88FF8800, 0x00000000], [0, .3, .7, 1]);
    circle(ctx, W * .5, sunY, H * .14);
    ctx.strokeStyle = C(0x22FFCC00); ctx.lineWidth = H * .015;
    for (let r = 0; r < 12; r++) { const a = r * Math.PI / 6 + tick * .1; line(ctx, W * .5 + Math.cos(a) * H * .08, sunY + Math.sin(a) * H * .08, W * .5 + Math.cos(a) * H * .22, sunY + Math.sin(a) * H * .22, C(0x22FFCC00), H * .015); }
    ctx.fillStyle = linGrad(ctx, 0, H * .65, 0, H, [0x88FF8800, 0x44FF4400, 0xFF050020]); rect(ctx, 0, H * .65, W, H);
    for (let i = 0; i < 12; i++) { const rx = W * .3 + Math.sin(tick * 2 + i) * W * .25, ry = H * .7 + i * H * .022; line(ctx, rx - W * .06, ry, rx + W * .06, ry, C(0x55FFAA00), 2); }
    ctx.fillStyle = C(0xCC0A0010);
    ctx.beginPath(); ctx.moveTo(0, H * .65); ctx.bezierCurveTo(W * .15, H * .5, W * .30, H * .62, W * .45, H * .55);
    ctx.bezierCurveTo(W * .60, H * .48, W * .75, H * .60, W, H * .63); ctx.lineTo(W, H * .65); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = C(0xFF0A0020); ctx.lineWidth = H * .005;
    for (let b = 0; b < 7; b++) { const bx = (W * .1 + b * W * .13 + tick * 15 * (b % 2 === 0 ? 1 : -1)) % W, by = H * .18 + Math.sin(tick + b) * H * .03;
      ctx.beginPath(); ctx.moveTo(bx - H * .012, by); ctx.bezierCurveTo(bx - H * .006, by - H * .01, bx + H * .006, by - H * .01, bx + H * .012, by); ctx.stroke(); }
  }

  // ═══ WINDMILL ═══
  let windAngle = 0;
  function cloud(cx, cy, r) { ctx.fillStyle = C(0xEEFFFFFF); circle(ctx, cx, cy, r); circle(ctx, cx + r * .7, cy + r * .2, r * .75); circle(ctx, cx - r * .6, cy + r * .25, r * .65); rect(ctx, cx - r * 1.2, cy + r * .1, cx + r * 1.5, cy + r * .85); }
  function windmillUnit(x, baseY, h, angle) {
    ctx.fillStyle = C(0xFFDDCCAA);
    ctx.beginPath(); ctx.moveTo(x - h * .08, baseY); ctx.lineTo(x + h * .08, baseY); ctx.lineTo(x + h * .03, baseY - h); ctx.lineTo(x - h * .03, baseY - h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C(0xFFEEEECC);
    for (let b = 0; b < 4; b++) { const a = angle + b * Math.PI / 2, bx = x + Math.cos(a) * h * .42, by = (baseY - h) + Math.sin(a) * h * .42, perp = a + Math.PI / 2, w2 = h * .025;
      ctx.beginPath(); ctx.moveTo(x + Math.cos(perp) * w2, (baseY - h) + Math.sin(perp) * w2); ctx.lineTo(bx + Math.cos(perp) * w2 * .3, by + Math.sin(perp) * w2 * .3);
      ctx.lineTo(bx - Math.cos(perp) * w2 * .3, by - Math.sin(perp) * w2 * .3); ctx.lineTo(x - Math.cos(perp) * w2, (baseY - h) - Math.sin(perp) * w2); ctx.closePath(); ctx.fill(); }
    circle(ctx, x, baseY - h, h * .04, C(0xFF888866));
  }
  function drawWindmill() {
    windAngle += 0.02;
    fillGrad(ctx, W, H, [0xFF87CEEB, 0xFF4A90D9, 0xFF87CEEB, 0xFF5DBB63], [0, .4, .65, 1]);
    for (let c = 0; c < 4; c++) cloud((W * (.1 + c * .25) + tick * 10 * (c % 2 === 0 ? 1 : -1)) % W, H * (.08 + c * .05), W * .1);
    ctx.fillStyle = linGrad(ctx, 0, H * .65, 0, H, [0xFF5DBB63, 0xFF3A8A40, 0xFF2D6E35]); rect(ctx, 0, H * .65, W, H);
    ctx.fillStyle = C(0xFF4DAD53);
    ctx.beginPath(); ctx.moveTo(0, H * .65); for (let x = 0; x <= W; x += 10) ctx.lineTo(x, H * .65 - Math.sin(x / (W * .2) + tick * .05) * H * .06); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
    windmillUnit(W * .20, H * .62, H * .28, windAngle); windmillUnit(W * .55, H * .60, H * .35, windAngle * .8); windmillUnit(W * .82, H * .63, H * .22, windAngle * 1.2);
  }

  // ═══ WATERFALL ═══
  let wfP;
  function fern(x, y, h, phase) { ctx.strokeStyle = C(0xFF1A5C1A); ctx.lineWidth = 3; for (let l = 0; l < 5; l++) { const a = -Math.PI / 2 + (l - 2) * .35 + Math.sin(phase * .5) * .1; line(ctx, x, y, x + Math.cos(a) * h * (l * .2 + .3), y + Math.sin(a) * h * (l * .2 + .3), C(0xFF1A5C1A), 3); } }
  function drawWaterfall() {
    fillGrad(ctx, W, H, [0xFF0A1F0A, 0xFF0D2E0D, 0xFF1A4A1A, 0xFF0D2E0D]);
    rect(ctx, 0, H * .1, W * .28, H * .75, C(0xFF3D3224)); rect(ctx, W * .72, H * .1, W, H * .75, C(0xFF3D3224));
    ctx.fillStyle = linGrad(ctx, W * .28, 0, W * .72, 0, [0x8800B4D8, 0xCC00FFD4, 0x8800B4D8]); rect(ctx, W * .28, H * .1, W * .72, H * .72);
    if (!wfP) wfP = field(80).map(() => ({ x: W * .25 + rnd() * W * .5, y: rnd() * H * .6, s: 1.5 + rnd() * 3, v: 6 + rnd() * 10 }));
    wfP.forEach((p, i) => { p.y += p.v; p.x += Math.sin(tick + i * .3) * 1.2; if (p.y > H * .75) { p.x = W * .25 + rnd() * W * .5; p.y = H * .12; } oval(ctx, p.x - p.s * .4, p.y - p.s, p.x + p.s * .4, p.y + p.s, C(0xBBE0FFFF)); });
    ctx.fillStyle = radGrad(ctx, W * .5, H * .75, W * .3, [0xFF00B4D8, 0xFF0077B6, 0xFF023E8A]); oval(ctx, W * .15, H * .70, W * .85, H * .85);
    for (let r = 1; r <= 5; r++) { const rs = (tick * 40 + r * 35) % (W * .4); oval(ctx, W * .5 - rs, H * .76 - rs * .4, W * .5 + rs, H * .76 + rs * .4, C(0x3388EEFF)); }
    for (let f = 0; f < 8; f++) fern(f < 4 ? W * .02 + f * W * .07 : W * .75 + (f - 4) * W * .065, H * .65, H * .15, tick + f);
  }

  // ═══ UNDERSEA ═══
  let fishP;
  function drawFishShape(x, y, size, dir, phase) {
    const flip = dir < 0 ? -1 : 1;
    ctx.beginPath(); ctx.moveTo(x + flip * size * .6, y);
    ctx.bezierCurveTo(x + flip * size * .4, y - size * .35, x - flip * size * .4, y - size * .35, x - flip * size * .6, y);
    ctx.bezierCurveTo(x - flip * size * .4, y + size * .35, x + flip * size * .4, y + size * .35, x + flip * size * .6, y);
    ctx.closePath(); ctx.fill();
    const tailX = x - flip * size * .58, wobble = Math.sin(phase * 5) * size * .25;
    ctx.beginPath(); ctx.moveTo(tailX, y); ctx.lineTo(tailX - flip * size * .45, y - size * .35 + wobble); ctx.lineTo(tailX - flip * size * .45, y + size * .35 + wobble); ctx.closePath(); ctx.fill();
    circle(ctx, x + flip * size * .3, y - size * .1, size * .1, C(0xFFFFFFFF)); circle(ctx, x + flip * size * .32, y - size * .1, size * .055, C(0xFF222222));
  }
  function drawUndersea() {
    fillGrad(ctx, W, H, [0xFF001B2E, 0xFF003459, 0xFF006994, 0xFF00A8CC, 0xFF00C9B4]);
    for (let s = 0; s < 7; s++) { const sx = W * (.05 + s * .15) + Math.sin(tick * .3 + s) * W * .04; ctx.fillStyle = C(0x0A7FFFFF);
      ctx.beginPath(); ctx.moveTo(sx - W * .02, 0); ctx.lineTo(sx + W * .02, 0); ctx.lineTo(sx + W * .07, H); ctx.lineTo(sx - W * .07, H); ctx.closePath(); ctx.fill(); }
    const cc = [0xFFFF6B9D, 0xFFFF9B71, 0xFF96F7D2, 0xFF845EC2, 0xFFFF8066];
    for (let c = 0; c < 12; c++) { ctx.strokeStyle = C(cc[c % cc.length]); ctx.lineWidth = 4; const x = W * (c / 11), base = H * .82, h = H * (.04 + (c % 3) * .025);
      ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x, base - h); ctx.stroke(); circle(ctx, x, base - h * .6, 5, C(cc[c % cc.length])); }
    ctx.fillStyle = linGrad(ctx, 0, H * .9, 0, H, [0xFFD4A853, 0xFFAA8833, 0xFF886622]); rect(ctx, 0, H * .88, W, H);
    if (!fishP) fishP = field(8).map(() => ({ x: rnd() * W, y: H * (.15 + rnd() * .7), d: rnd() > .5 ? 1 : -1, s: 1.5 + rnd() * 2 }));
    const fc = [0xFFFF8C42, 0xFF6C7FFF, 0xFF88FF66, 0xFFFF66CC, 0xFFFFDD44];
    fishP.forEach((f, i) => { f.x += f.d * f.s * .8; f.y += Math.sin(tick * .8 + i) * .5; if (f.x > W + 60) f.x = -60; if (f.x < -60) f.x = W + 60;
      ctx.fillStyle = C(fc[i % fc.length]); drawFishShape(f.x, f.y, H * .04 * f.s, f.d, tick + i); });
    ctx.strokeStyle = C(0x5500EEFF); ctx.lineWidth = 2;
    for (let b = 0; b < 20; b++) { const bx = W * (b / 20) + Math.sin(tick * .5 + b) * W * .02, by = ((H - (tick * 25 + b * H / 20) % H) + H) % H; ctx.beginPath(); ctx.arc(bx, by, 4 + (b % 3) * 2, 0, Math.PI * 2); ctx.stroke(); }
  }

  // ═══ SMOKE ═══
  let smokeP;
  function drawSmoke() {
    fillGrad(ctx, W, H, [0xFF0C0C0C, 0xFF1A1A2E, 0xFF16213E, 0xFF0F3460]);
    ctx.fillStyle = linGrad(ctx, 0, H * .7, 0, H, [0x44FF6600, 0x22FF2200, 0x00000000]); rect(ctx, 0, H * .7, W, H);
    for (let e = 0; e < 15; e++) { const ex = W * (e / 15) + Math.sin(tick + e) * W * .02, inten = .5 + .5 * Math.sin(tick * 3 + e);
      circle(ctx, ex, H * (.78 + e * .012), 3 + inten * 4, `rgba(255,${68 + inten * 80 | 0},0,${inten * .78})`); }
    if (!smokeP) smokeP = field(60).map(() => ({ x: W * .5 + (rnd() - .5) * W * .1, y: H * (.5 + rnd() * .5), r: 20 + rnd() * 60, a: .05 + rnd() * .25, vy: -(1 + rnd() * 2.5), vx: (rnd() - .5) * 1.2 }));
    smokeP.forEach((p, i) => { p.y += p.vy; p.x += p.vx + Math.sin(tick * .5 + i * .4) * .8; p.r += .4; p.a -= .002;
      if (p.y < 0 || p.a <= 0) { p.x = W * .5 + (rnd() - .5) * W * .08; p.y = H * .75; p.r = 15 + rnd() * 30; p.a = .12 + rnd() * .2; }
      ctx.fillStyle = radGrad(ctx, p.x, p.y, p.r, [`rgba(180,180,190,${Math.max(0, p.a)})`, "rgba(180,180,190,0)"]); circle(ctx, p.x, p.y, p.r); });
  }

  // ═══ PIANO ═══
  let pianoKeys;
  function drawPiano() {
    fillGrad(ctx, W, H, [0xFF0A0008, 0xFF120015, 0xFF1E0030, 0xFF0A0008]);
    ctx.fillStyle = radGrad(ctx, W * .5, 0, H * .6, [0x33FFEEAA, 0x11FFAA00, 0x00000000]); rect(ctx, 0, 0, W, H);
    const py0 = H * .55;
    ctx.fillStyle = C(0xFF111111); ctx.beginPath(); ctx.moveTo(W * .08, py0); ctx.lineTo(W * .08, py0 - H * .08); ctx.lineTo(W * .35, py0 - H * .12);
    ctx.bezierCurveTo(W * .60, py0 - H * .14, W * .85, py0 - H * .05, W * .92, py0 + H * .03); ctx.lineTo(W * .92, py0); ctx.closePath(); ctx.fill();
    rect(ctx, W * .15, py0, W * .19, py0 + H * .18, C(0xFF111111)); rect(ctx, W * .78, py0, W * .82, py0 + H * .15, C(0xFF111111));
    if (!pianoKeys) pianoKeys = Array.from({ length: 14 }, () => ({ pressed: false, amt: 0 }));
    const keyW = W * .058, keyH = H * .13, keyY = py0 - H * .06, keysX = W * .1;
    const noteColors = [0xFF00FFD4, 0xFF7B2FFF, 0xFFFF2D78, 0xFFFFE500, 0xFF00AAFF];
    pianoKeys.forEach((k, i) => {
      if (Math.random() < .02) k.pressed = !k.pressed;
      k.amt = k.pressed ? Math.min(1, k.amt + .15) : Math.max(0, k.amt - .08);
      const kx = keysX + i * keyW * .97, off = k.amt * H * .01;
      ctx.fillStyle = linGrad(ctx, kx, keyY + off, kx, keyY + keyH + off, [0xFFEEEEEE, 0xFFCCCCCC]); rect(ctx, kx + 1, keyY + off, kx + keyW - 2, keyY + keyH + off);
      if (k.amt > .1) { ctx.fillStyle = C(noteColors[i % 5], k.amt * .6); rect(ctx, kx + 1, keyY + off, kx + keyW - 2, keyY + keyH + off);
        for (let n = 0; n < 3; n++) { const rise = (tick * 40 + n * 25) % (H * .4); circle(ctx, kx + keyW / 2, keyY - rise, 4 - n, C(noteColors[i % 5])); } }
    });
    const bkPos = [0, 1, 3, 4, 5, 7, 8, 10, 11, 12], bkW = keyW * .55, bkH = keyH * .6;
    ctx.fillStyle = C(0xFF111111); bkPos.forEach(bk => rect(ctx, keysX + bk * keyW * .97 + keyW * .67, keyY, keysX + bk * keyW * .97 + keyW * .67 + bkW, keyY + bkH));
    ctx.strokeStyle = C(0x88FFD4AA); ctx.lineWidth = 2.5;
    for (let n = 0; n < 8; n++) { const nx = (W * (n / 8) + tick * 18 * (n % 2 === 0 ? 1 : -.7)) % W, rise = (tick * 15 + n * 30) % (H * .3), y = keyY - rise * .8, size = H * .025;
      circle(ctx, nx, y, size * .5, "transparent"); ctx.strokeStyle = C(0x88FFD4AA); ctx.beginPath(); ctx.arc(nx, y, size * .5, 0, Math.PI * 2); ctx.stroke();
      line(ctx, nx + size * .45, y, nx + size * .45, y - size * 1.8, C(0x88FFD4AA), 2.5); line(ctx, nx + size * .45, y - size * 1.8, nx + size * 1.2, y - size * 1.4, C(0x88FFD4AA), 2.5); }
  }

  // ═══ THINKING ═══
  const BUB_X = [.5, .58, .65, .70], BUB_Y = [.48, .38, .28, .18], BUB_R = [.04, .055, .07, .11];
  function drawThinking() {
    fillGrad(ctx, W, H, [0xFF0D0D2B, 0xFF1A1A4E, 0xFF2D2D8A, 0xFF1A1A4E]);
    for (let s = 0; s < 60; s++) { const sx = (s * 137.5) % W, sy = (s * 97.3) % (H * .55), sa = .4 + .6 * Math.sin(tick * 2 + s); circle(ctx, sx, sy, 1.5 + (s % 3) * .7, C(0xFFFFFFFF, sa * .78)); }
    const bPhase = Math.sin(tick * .4) * .02;
    for (let b = 0; b < 4; b++) { const bx = W * BUB_X[b], by = H * (BUB_Y[b] + bPhase * (b + 1)), br = W * BUB_R[b], alpha = .5 + .3 * Math.sin(tick * .8 + b);
      ctx.fillStyle = radGrad(ctx, bx, by, br, [`rgba(80,120,200,${alpha})`, `rgba(20,30,80,${alpha * .47})`]); circle(ctx, bx, by, br);
      circle(ctx, bx - br * .3, by - br * .3, br * .2, C(0xFFFFFFFF, alpha * .39)); }
    // thinking person
    const cx = W * .35, baseY = H * .88, u = H * .04;
    ctx.fillStyle = C(0xFF1A1A3E); circle(ctx, cx, baseY - u * 5.5, u * 1.1); ctx.fillStyle = C(0xFF2A2A5E); circle(ctx, cx + u * 1.2, baseY - u * 4.5, u * .55);
    ctx.fillStyle = C(0xFF1A1A3E); rect(ctx, cx - u, baseY - u * 4.2, cx + u, baseY - u);
    ctx.strokeStyle = C(0xFF1A1A3E); ctx.lineWidth = u * .6; ctx.beginPath(); ctx.moveTo(cx + u, baseY - u * 3.8);
    ctx.bezierCurveTo(cx + u * 2, baseY - u * 3, cx + u * 2.5, baseY - u * 2, cx + u * 1.8, baseY - u * 1.2); ctx.stroke();
    ctx.fillStyle = C(0xFF2A1A0A); rect(ctx, cx - u * 2.5, baseY, cx + u * 2.5, baseY + u * .4);
    const topBX = W * BUB_X[3], topBY = H * BUB_Y[3];
    for (let sp = 0; sp < 8; sp++) { const a = sp * Math.PI / 4 + tick, sx = topBX + Math.cos(a) * W * (BUB_R[3] + .04), sy = topBY + Math.sin(a) * W * (BUB_R[3] + .04), sa = .5 + .5 * Math.sin(tick * 4 + sp);
      circle(ctx, sx, sy, 4, C(0xFFFFDC32, sa)); }
  }

  // ═══ AURORA ═══
  let auroraPhase = 0;
  function drawAurora() {
    auroraPhase += .01;
    fillGrad(ctx, W, H, [0xFF000510, 0xFF010A20, 0xFF000510]);
    for (let s = 0; s < 80; s++) circle(ctx, (s * 151.3) % W, (s * 79.1) % (H * .5), 1 + (s % 3) * .5, C(0xCCFFFFFF));
    const ac = [[0x4400FF88, 0x6600FFAA, 0x4400FF88], [0x440088FF, 0x660099FF, 0x440066FF], [0x44BB00FF, 0x66CC00FF, 0x44AA00FF], [0x4400FFDD, 0x5500EEBB, 0x3300CCAA]];
    const ry = [.25, .30, .20, .35], rh = [.20, .15, .18, .12];
    for (let r = 0; r < 4; r++) { const bY = H * ry[r], rhh = H * rh[r], phase = auroraPhase * (1 + r * .3) + r * 1.2;
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 8) { const t = x / W, y = bY + rhh * (.5 + .5 * Math.sin(t * Math.PI * 2 + phase)); ctx.lineTo(x, y + rhh); }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = linGrad(ctx, 0, bY, 0, bY + rhh * 2, ac[r]); ctx.fill(); }
    ctx.fillStyle = linGrad(ctx, 0, H * .75, 0, H, [0xFFCCEEFF, 0xFF99CCEE, 0xFF667799]);
    ctx.beginPath(); ctx.moveTo(0, H * .75); for (let x = 0; x <= W; x += 10) ctx.lineTo(x, H * .75 + Math.sin(x / (W * .15)) * H * .02); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
  }

  // ═══ SHARK ═══
  let shark;
  function drawShark() {
    if (!shark) shark = { x: -.3, y: .5, dir: 1, biting: false, biteAnim: 0, biteTimer: 0 };
    shark.biteTimer += .016;
    if (!shark.biting) { shark.x += shark.dir * .004; shark.y = .5 + Math.sin(tick * .8) * .06;
      if (shark.x > 1.3) { shark.x = -.3; shark.dir = 1; } if (shark.x < -.3) { shark.x = 1.3; shark.dir = -1; }
      if (shark.biteTimer > 3.5) { shark.biting = true; shark.biteTimer = 0; shark.biteAnim = 0; }
    } else { shark.biteAnim = Math.min(1, shark.biteAnim + .04); shark.y -= .007; if (shark.biteTimer > 1.8) { shark.biting = false; shark.biteTimer = 0; shark.y = .5; } }
    fillGrad(ctx, W, H, [0xFF000D1A, 0xFF001F3F, 0xFF003D7A, 0xFF0055A0, 0xFF004080]);
    ctx.strokeStyle = C(0x5500EEFF); ctx.lineWidth = 2;
    for (let b = 0; b < 15; b++) { const bx = W * (b / 15 + Math.sin(tick * .3 + b) * .02), by = ((H - tick * 20 * (1 + b % 3) - b * H / 15) % H + H) % H; ctx.beginPath(); ctx.arc(bx, by, 3 + (b % 4) * 2, 0, Math.PI * 2); ctx.stroke(); }
    const sx = shark.x * W, sy = shark.y * H, bodyLen = W * .45, bodyH = H * .09, flip = shark.dir < 0 ? -1 : 1;
    oval(ctx, sx - bodyLen * .4, sy + bodyH * .6, sx + bodyLen * .4, sy + bodyH * 1.2, C(0x33000000));
    ctx.fillStyle = C(0xFF607080);
    ctx.beginPath(); ctx.moveTo(sx + flip * bodyLen * .5, sy);
    ctx.bezierCurveTo(sx + flip * bodyLen * .3, sy - bodyH * .7, sx - flip * bodyLen * .2, sy - bodyH * .6, sx - flip * bodyLen * .5, sy);
    ctx.bezierCurveTo(sx - flip * bodyLen * .2, sy + bodyH * .5, sx + flip * bodyLen * .3, sy + bodyH * .5, sx + flip * bodyLen * .5, sy); ctx.closePath(); ctx.fill();
    const dfx = sx - flip * bodyLen * .05; ctx.fillStyle = C(0xFF506070);
    ctx.beginPath(); ctx.moveTo(dfx, sy - bodyH * .55); ctx.lineTo(dfx - flip * bodyLen * .12, sy - bodyH * 1.5); ctx.lineTo(dfx + flip * bodyLen * .15, sy - bodyH * .55); ctx.closePath(); ctx.fill();
    const tailX = sx - flip * bodyLen * .48;
    ctx.beginPath(); ctx.moveTo(tailX, sy); ctx.lineTo(tailX - flip * bodyLen * .18, sy - bodyH * .7); ctx.lineTo(tailX - flip * bodyLen * .05, sy); ctx.lineTo(tailX - flip * bodyLen * .18, sy + bodyH * .7); ctx.closePath(); ctx.fill();
    circle(ctx, sx + flip * bodyLen * .28, sy - bodyH * .1, bodyH * .13, C(0xFF000000));
    const mouthOpen = shark.biting ? shark.biteAnim * bodyH * .55 : bodyH * .05, mouthX = sx + flip * bodyLen * .44;
    ctx.fillStyle = C(0xFF607080);
    ctx.beginPath(); ctx.moveTo(mouthX, sy - mouthOpen); ctx.lineTo(mouthX - flip * bodyLen * .12, sy - mouthOpen * .3); ctx.lineTo(mouthX - flip * bodyLen * .12, sy); ctx.lineTo(mouthX, sy); ctx.closePath(); ctx.fill();
    if (shark.biting && shark.biteAnim > .2) { ctx.fillStyle = C(0xFFF8F8F0); for (let t = 0; t < 5; t++) { const tx = mouthX - flip * t * bodyLen * .02, th = mouthOpen * .6;
      line(ctx, tx, sy - mouthOpen * .1, tx, sy - mouthOpen * .1 - th, C(0xFFF8F8F0), 2); } }
    ctx.fillStyle = linGrad(ctx, 0, H * .7, 0, H, [0x00000000, 0xCC000D1A]); rect(ctx, 0, H * .7, W, H);
  }

  // ═══ DOG ═══
  let dog;
  function drawDog() {
    if (!dog) dog = { slobberX: field(8).map(() => .5 + (rnd() - .5) * .08), slobberY: field(8).map(() => .72 + rnd() * .05), slobberV: field(8).map(() => .003 + rnd() * .004) };
    const tongueOut = .6 + .4 * Math.sin(tick * 4), tailWag = Math.sin(tick * 8);
    fillGrad(ctx, W, H, [0xFF2A1000, 0xFF4A2200, 0xFF3D1A00, 0xFF1A0800]);
    ctx.fillStyle = linGrad(ctx, 0, H * .82, 0, H, [0xFF6B3A1F, 0xFF4A2510]); rect(ctx, 0, H * .82, W, H);
    ctx.fillStyle = radGrad(ctx, W * .85, H * .2, W * .2, [0x44FFDD88, 0x11FF8800, 0x00000000]); rect(ctx, 0, 0, W, H);
    const cx = W * .5, baseY = H * .82, u = H * .07;
    ctx.fillStyle = C(0xFFD4853A); oval(ctx, cx - u * 1.5, baseY - u * 2.5, cx + u * 1.5, baseY - u * .5); circle(ctx, cx, baseY - u * 3.2, u * 1.1);
    ctx.fillStyle = C(0xFFE8A060); oval(ctx, cx - u * .55, baseY - u * 2.9, cx + u * .55, baseY - u * 2.2);
    ctx.fillStyle = C(0xFF2A1A10); ctx.beginPath(); ctx.moveTo(cx, baseY - u * 2.85); ctx.lineTo(cx - u * .22, baseY - u * 2.55); ctx.lineTo(cx + u * .22, baseY - u * 2.55); ctx.closePath(); ctx.fill();
    const tongLen = u * .8 * tongueOut; ctx.fillStyle = C(0xFFFF6688);
    ctx.beginPath(); ctx.moveTo(cx - u * .22, baseY - u * 2.4);
    ctx.bezierCurveTo(cx - u * .25, baseY - u * 2.4 + tongLen * .4, cx + u * .25, baseY - u * 2.4 + tongLen * .4, cx + u * .22, baseY - u * 2.4);
    ctx.bezierCurveTo(cx + u * .3, baseY - u * 2 + tongLen, cx, baseY - u * 1.7 + tongLen, cx, baseY - u * 1.8 + tongLen); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C(0xFF3D2A10); circle(ctx, cx - u * .45, baseY - u * 3.4, u * .18); circle(ctx, cx + u * .45, baseY - u * 3.4, u * .18);
    ctx.fillStyle = C(0xFFFFFFFF); circle(ctx, cx - u * .4, baseY - u * 3.45, u * .06); circle(ctx, cx + u * .4, baseY - u * 3.45, u * .06);
    ctx.fillStyle = C(0xFFD4853A); rect(ctx, cx - u * 1.3, baseY - u * 1.2, cx - u * .7, baseY); rect(ctx, cx + u * .7, baseY - u * 1.2, cx + u * 1.3, baseY);
    const tailBaseX = cx + u * 1.5, tailBaseY = baseY - u * 1.8, tailEndX = tailBaseX + u * 1.5, tailEndY = tailBaseY - u * 1.5 + tailWag * u * .8;
    ctx.strokeStyle = C(0xFFD4853A); ctx.lineWidth = u * .45; ctx.lineCap = "round"; line(ctx, tailBaseX, tailBaseY, tailEndX, tailEndY, C(0xFFD4853A), u * .45); ctx.lineCap = "butt";
    ctx.fillStyle = C(0x99CCEEEE); dog.slobberY.forEach((y, i) => { dog.slobberY[i] += dog.slobberV[i]; if (dog.slobberY[i] > 1.1) { dog.slobberX[i] = .5 + (rnd() - .5) * .08; dog.slobberY[i] = .72; }
      const sy2 = dog.slobberY[i] * H; if (sy2 < baseY + u * .5) oval(ctx, dog.slobberX[i] * W - u * .08, sy2, dog.slobberX[i] * W + u * .08, sy2 + u * .35); });
    ctx.fillStyle = C(0xAAB86B25); [.2, .3, .7, .8].forEach(px2 => { const ppx = px2 * W, ppy = H * .9; oval(ctx, ppx - u * .25, ppy - u * .15, ppx + u * .25, ppy + u * .15); });
  }

  // ═══ CAT ═══
  let cat;
  function drawCat() {
    if (!cat) cat = { x: -.2, sleeping: false, sleepAmt: 0, sleepTimer: 0, phase: 0, tailWag: 0 };
    cat.tailWag = Math.sin(tick * 3);
    if (!cat.sleeping) { cat.x += .006; cat.phase = tick * 10; if (cat.x > 1.2) { cat.sleeping = true; cat.sleepAmt = 0; cat.sleepTimer = 0; cat.x = .55; } }
    else { cat.sleepTimer += .016; cat.sleepAmt = Math.min(1, cat.sleepAmt + .02); if (cat.sleepTimer > 4) { cat.sleeping = false; cat.x = -.2; } }
    fillGrad(ctx, W, H, [0xFF1A0D20, 0xFF2D1540, 0xFF1A0A25, 0xFF100818]);
    ctx.fillStyle = linGrad(ctx, W * .6, 0, W, H * .6, [0x22FFAA44, 0x00000000]); rect(ctx, 0, 0, W, H);
    ctx.fillStyle = linGrad(ctx, 0, H * .78, 0, H, [0xFF3D2050, 0xFF2A1035]); rect(ctx, 0, H * .78, W, H);
    const baseY = H * .78, u = H * .065;
    if (!cat.sleeping) {
      const cx = cat.x * W, runBob = Math.sin(cat.phase) * u * .12;
      ctx.fillStyle = C(0xFF808090); oval(ctx, cx - u * 1.3, baseY - u * 1.5 + runBob, cx + u * .8, baseY - u * .3 + runBob); circle(ctx, cx + u * .8, baseY - u * 1.8 + runBob, u * .75);
      ctx.fillStyle = C(0xFF3A3030); circle(ctx, cx + u * .6, baseY - u * 1.88 + runBob, u * .13); circle(ctx, cx + u * 1.0, baseY - u * 1.88 + runBob, u * .13);
      ctx.strokeStyle = C(0xFF808090); ctx.lineWidth = u * .3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(cx - u * 1.3, baseY - u * .5 + runBob);
      ctx.bezierCurveTo(cx - u * 1.8, baseY - u * 1 + runBob, cx - u * 2.2, baseY - u * .3 + runBob + cat.tailWag * u * .6, cx - u * 2, baseY - u * 1.2 + runBob + cat.tailWag * u * .5); ctx.stroke(); ctx.lineCap = "butt";
    } else {
      const cx = cat.x * W, breathe = Math.sin(tick * 1.2) * u * .05, curl = cat.sleepAmt;
      ctx.fillStyle = C(0xFF808090); oval(ctx, cx - u * 1.3 * curl - u * .3, baseY - u * .9 + breathe, cx + u * 1.3 * curl + u * .3, baseY + breathe);
      circle(ctx, cx + u * (1.2 * curl - .2), baseY - u * .85 + breathe, u * .65);
      if (cat.sleepAmt > .5) { ctx.fillStyle = C(0xAADDCCFF); for (let z = 0; z < 3; z++) { const zRise = (tick * 18 + z * 22) % (H * .3), zx = cx + u * (1.5 * curl + .5) + Math.sin(tick + z) * u * .3, zy = baseY - u * 1.2 - zRise;
        ctx.font = `${u * (.5 + z * .3) * .8}px monospace`; ctx.fillText("z", zx, zy); } }
    }
  }

  // ═══ SAHARA ═══
  let sunAngle = 0;
  function drawSahara() {
    sunAngle += .008; if (sunAngle > Math.PI * 2) sunAngle -= Math.PI * 2;
    const t = sunAngle / (Math.PI * 2), sunX = W * t, sunY = H * .15 + H * .55 * Math.pow(2 * t - 1, 2), isNight = t > .85 || t < .1;
    let skyTop, skyMid, skyHoriz;
    if (isNight) { skyTop = 0xFF020518; skyMid = 0xFF0A1040; skyHoriz = 0xFF180830; }
    else if (t < .15 || t > .8) { skyTop = 0xFF0A0020; skyMid = 0xFFCC4400; skyHoriz = 0xFFFF8800; }
    else { skyTop = 0xFF0D4FA0; skyMid = 0xFF2D88CC; skyHoriz = 0xFFF0C060; }
    fillGrad(ctx, W, H, [skyTop, skyMid, skyHoriz, 0xFFD4A853], [0, .4, .62, 1]);
    if (isNight) { ctx.fillStyle = radGrad(ctx, W * .75, H * .12, H * .07, [0xFFFFEECC, 0xFFDDCC88, 0x00000000]); circle(ctx, W * .75, H * .12, H * .07); }
    else { const sunSize = H * (t > .1 && t < .9 ? .1 : .13), sunColor = (t > .15 && t < .8) ? 0xFFFFEE44 : 0xFFFF8844;
      ctx.fillStyle = radGrad(ctx, sunX, sunY, sunSize * 1.8, [0xFFFFFFAA, sunColor, 0x44FF8800, 0x00000000], [0, .25, .6, 1]); circle(ctx, sunX, sunY, sunSize * 1.8); }
    const duneColors = [0xFFE8C880, 0xFFD4A853, 0xFFC09040, 0xFFAA7830], duneY = [.62, .68, .74, .80];
    for (let d = 3; d >= 0; d--) { ctx.fillStyle = linGrad(ctx, 0, H * duneY[d], 0, H, [duneColors[d], 0xFF8A5E28]);
      ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(0, H * duneY[d]);
      for (let x = 0; x <= W; x += 10) ctx.lineTo(x, H * duneY[d] + Math.sin(x / (W * (.25 + d * .1)) + d * 1.5) * H * .04);
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = C(0xFF5A3010); const camX = W * .25, camY = H * .72, camU = H * .06;
    oval(ctx, camX - camU * .7, camY - camU * .8, camX + camU * .7, camY); oval(ctx, camX - camU * .5, camY - camU * 1.4, camX, camY - camU * .6); oval(ctx, camX + camU * .1, camY - camU * 1.2, camX + camU * .6, camY - camU * .5);
    rect(ctx, camX + camU * .4, camY - camU * 2, camX + camU * .65, camY - camU * .7); oval(ctx, camX + camU * .3, camY - camU * 2.4, camX + camU * .9, camY - camU * 1.8);
  }

  // ═══ DARKNESS ═══
  let dk;
  function drawDarkness() {
    if (!dk) dk = { lightLevel: 0, lightTarget: 0, lightTimer: 0 };
    dk.lightTimer += .016; const cyc = dk.lightTimer % 6;
    dk.lightTarget = cyc < 3.5 ? 0 : cyc < 4 ? .8 + .2 * Math.sin(tick * 20) : cyc < 5 ? 1 : 0;
    dk.lightLevel += (dk.lightTarget - dk.lightLevel) * .12;
    fillGrad(ctx, W, H, [0xFF050208, 0xFF08040D, 0xFF0A0510]);
    ctx.fillStyle = C(0xFFFFEEDD, dk.lightLevel * .9); rect(ctx, 0, 0, W, H);
    ctx.fillStyle = radGrad(ctx, W * .5, H * .5, W * .6, [`rgba(255,238,200,${dk.lightLevel * .5})`, "rgba(0,0,0,0)"]); rect(ctx, 0, 0, W, H);
    ctx.fillStyle = C(0xFF000000, .55 + .35 * (1 - dk.lightLevel)); rect(ctx, 0, 0, W, H);
    const fear = .5 + .5 * Math.sin(tick * 2.5); ctx.strokeStyle = C(0xFF880000, fear * .3 * (1 - dk.lightLevel)); ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
  }

  // ═══ LETTER ═══
  let letter;
  function drawLetter() {
    if (!letter) letter = { flicker: 1, reveal: 0, tearY1: rnd(), tearY2: rnd() };
    letter.flicker = .8 + .2 * Math.sin(tick * 9); letter.reveal = Math.min(1, (letter.reveal || 0) + .003);
    letter.tearY1 = (letter.tearY1 + .002) % 1; letter.tearY2 = (letter.tearY2 + .0017) % 1;
    fillGrad(ctx, W, H, [0xFF100A08, 0xFF1A1008, 0xFF120C06, 0xFF0D0806]);
    const candleX = W * .72, candleY = H * .55, fl = letter.flicker;
    ctx.fillStyle = radGrad(ctx, candleX, candleY, H * .4 * fl, [`rgba(255,200,80,${fl * .47})`, `rgba(200,120,30,${fl * .24})`, "rgba(0,0,0,0)"]); rect(ctx, 0, 0, W, H);
    rect(ctx, candleX - W * .015, candleY, candleX + W * .015, candleY + H * .08, C(0xFFF0EDD0));
    ctx.fillStyle = linGrad(ctx, 0, H * .62, 0, H, [0xFF4A2E10, 0xFF2A1808]); rect(ctx, 0, H * .62, W, H);
    const lx = W * .15, ly = H * .35, lw = W * .52, lh = H * .32;
    rect(ctx, lx + W * .02, ly + H * .02, lx + lw + W * .02, ly + lh + H * .02, C(0x44000000));
    rect(ctx, lx, ly, lx + lw, ly + lh, C(0xFFF5EDD5));
    ctx.strokeStyle = C(0xFF3A2810); const revealLen = letter.reveal * lw * .85, lineY = ly + lh * .12, lineSpacing = lh * .1, lineLeft = lx + lw * .08;
    const lineLengths = [.8, .95, .7, .85, .4];
    for (let l = 0; l < 5; l++) { const totalLine = l * lw * .85, lineReveal = Math.min(revealLen, lineLengths[l] * lw * .85);
      if (revealLen > totalLine) { const drawn = Math.min(lineReveal, revealLen - totalLine); ctx.lineWidth = 2.5; line(ctx, lineLeft, lineY + l * lineSpacing, lineLeft + drawn, lineY + l * lineSpacing, C(0xFF3A2810), 2.5); } }
    if (letter.reveal > .6) { const ha = Math.min(1, (letter.reveal - .6) * 2.5); ctx.fillStyle = C(0xB4B21E28, ha); const hx = lx + lw * .78, hy = ly + lh * .25, hs = lw * .06;
      ctx.beginPath(); ctx.moveTo(hx, hy + hs); ctx.bezierCurveTo(hx - hs, hy, hx - hs * 1.2, hy - hs * .8, hx, hy - hs * .3); ctx.bezierCurveTo(hx + hs * 1.2, hy - hs * .8, hx + hs, hy, hx, hy + hs); ctx.closePath(); ctx.fill(); }
    const childX = W * .30, childBaseY = H * .65, cU = H * .045;
    ctx.fillStyle = C(0xFF2A1808); oval(ctx, childX - cU, childBaseY - cU * .3, childX + cU, childBaseY + cU * .3); oval(ctx, childX - cU * .6, childBaseY - cU * 1.5, childX + cU * .6, childBaseY); circle(ctx, childX + cU * .2, childBaseY - cU * 2.1, cU * .7);
    const tear1Y = (childBaseY - cU * 1.6) + letter.tearY1 * H * .3, tear2Y = (childBaseY - cU * 1.7) + letter.tearY2 * H * .3;
    oval(ctx, childX - cU * .1, tear1Y, childX + cU * .08, tear1Y + cU * .4, C(0x99AADDFF)); oval(ctx, childX + cU * .2, tear2Y, childX + cU * .36, tear2Y + cU * .32, C(0x99AADDFF));
  }

  // ═══ BEACH ═══
  let beach;
  function drawBeach() {
    if (!beach) beach = { wave: 0, gulls: field(6).map(() => ({ x: rnd(), y: .08 + rnd() * .15, d: rnd() > .5 ? 1 : -1 })), umbX: [.18, .55, .82] };
    beach.wave += .016;
    fillGrad(ctx, W, H, [0xFF1A6BC4, 0xFF3A9EE8, 0xFF70C8F4, 0xFFFFE099, 0xFFFFD070], [0, .25, .5, .72, 1]);
    ctx.fillStyle = radGrad(ctx, W * .78, H * .13, H * .12, [0xFFFFFF88, 0xFFFFEE44, 0xAAFFCC00, 0x00000000]); circle(ctx, W * .78, H * .13, H * .12);
    const horizonY = H * .52; ctx.fillStyle = linGrad(ctx, 0, horizonY, 0, H * .72, [0xFF1A6BC4, 0xFF2A8FE0, 0xFF3AAEEE, 0xFF50C4F4]); rect(ctx, 0, horizonY, W, H * .72);
    for (let w = 0; w < 5; w++) { const wY = horizonY + w * H * .036, alpha = .3 + w * .12; ctx.strokeStyle = C(0xFFFFFFFF, alpha); ctx.lineWidth = 2 + w;
      ctx.beginPath(); ctx.moveTo(0, wY); for (let x = 0; x <= W; x += 8) ctx.lineTo(x, wY + H * .015 * Math.sin(x / (W * .12) + beach.wave * (1.5 - w * .2))); ctx.stroke(); }
    ctx.fillStyle = linGrad(ctx, 0, H * .70, 0, H, [0xFFE8D488, 0xFFD4BC60, 0xFFC0A840]); rect(ctx, 0, H * .70, W, H);
    const umbColors = [0xFFFF4444, 0xFF4444FF, 0xFF44BB44];
    beach.umbX.forEach((ux0, u2) => { const ux = ux0 * W, uy = H * .72, us = H * .12;
      rect(ctx, ux - us * .03, uy, ux + us * .03, uy + us * .9, C(0xFF886633));
      ctx.fillStyle = C(umbColors[u2]); ctx.beginPath(); ctx.moveTo(ux, uy - us * .1); ctx.lineTo(ux - us * .8, uy + us * .25); ctx.lineTo(ux + us * .8, uy + us * .25); ctx.closePath(); ctx.fill(); });
    ctx.strokeStyle = C(0xFF2A2A2A); ctx.lineWidth = 2.5;
    beach.gulls.forEach((g, i) => { g.x += g.d * .002; g.y += Math.sin(beach.wave * 1.5 + i) * .0008; if (g.x > 1.2) { g.x = -.2; g.d = 1; } if (g.x < -.2) { g.x = 1.2; g.d = -1; }
      const gx = g.x * W, gy = g.y * H, ws = W * .03, flap = Math.sin(beach.wave * 4 + i) * ws * .4;
      ctx.beginPath(); ctx.moveTo(gx - ws, gy + flap); ctx.bezierCurveTo(gx - ws * .5, gy - ws * .3, gx + ws * .5, gy - ws * .3, gx + ws, gy + flap); ctx.stroke(); });
    ctx.fillStyle = C(0xEEFFFFFF); for (let c = 0; c < 4; c++) cloud((W * (c * .28) + beach.wave * 8) % W, H * (.06 + c * .04), W * .08);
  }

  // ═══ JAMAICA ═══
  let jam;
  function palmTree(x, baseY, h, phase) {
    ctx.strokeStyle = C(0xFF6B4520); ctx.lineWidth = h * .06; ctx.lineCap = "round";
    const sway = Math.sin(phase * .5) * h * .08;
    ctx.beginPath(); ctx.moveTo(x, baseY); ctx.bezierCurveTo(x + sway * .3, baseY - h * .4, x + sway * .7, baseY - h * .7, x + sway, baseY - h); ctx.stroke(); ctx.lineCap = "butt";
    const tx = x + sway, ty = baseY - h, frondColors = [0xFF1A8A22, 0xFF22A030, 0xFF15781E];
    for (let f = 0; f < 7; f++) { const angle = f * Math.PI / 3.5 + phase * .2, fl = h * (.28 + (f * .02) % .1), ex = tx + Math.cos(angle) * fl, ey = ty + Math.sin(angle) * fl * .7;
      ctx.strokeStyle = C(frondColors[f % 3]); ctx.lineWidth = h * .025; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.bezierCurveTo(tx + Math.cos(angle) * fl * .4, ty + Math.sin(angle) * fl * .3, ex, ey, ex, ey); ctx.stroke(); ctx.lineCap = "butt"; }
  }
  function drawJamaica() {
    if (!jam) jam = { tick: 0 };
    jam.tick += .016;
    fillGrad(ctx, W, H, [0xFF1A88CC, 0xFF3AAAE0, 0xFF66CCF0, 0xFF88DDC0, 0xFF55BB88], [0, .2, .45, .65, 1]);
    ctx.fillStyle = radGrad(ctx, W * .8, H * .1, H * .14, [0xFFFFFF88, 0xFFFFDD00, 0x88FFAA00, 0x00000000]); circle(ctx, W * .8, H * .1, H * .14);
    ctx.fillStyle = linGrad(ctx, 0, H * .48, 0, H * .68, [0xFF0088CC, 0xFF00AADD, 0xFF22CCEE]); rect(ctx, 0, H * .48, W, H * .68);
    ctx.fillStyle = linGrad(ctx, 0, H * .65, 0, H, [0xFFEED888, 0xFFDDBB55, 0xFFCC9933]); rect(ctx, 0, H * .65, W, H);
    palmTree(W * .12, H * .68, H * .48, jam.tick); palmTree(W * .88, H * .70, H * .42, jam.tick + 1); palmTree(W * .03, H * .72, H * .35, jam.tick + 2);
    const shackX = W * .35, shackY = H * .62, rgg = [0xFFFFCC00, 0xFF008800, 0xFFDD0000];
    rgg.forEach((c, i) => rect(ctx, shackX + i * W * .06, shackY, shackX + (i + 1) * W * .06, shackY + H * .1, C(c)));
    ctx.fillStyle = C(0xFF5A3010); ctx.beginPath(); ctx.moveTo(shackX - W * .02, shackY); ctx.lineTo(shackX + W * .1, shackY - H * .08); ctx.lineTo(shackX + W * .2, shackY); ctx.closePath(); ctx.fill();
  }

  // ═══ REGGAETON ═══
  let regg;
  function drawReggaeton() {
    if (!regg) regg = { tick: 0, discs: field(20).map(() => ({ x: rnd(), y: rnd() * .7, r: 3 + rnd() * 8, c: [0xFFFF2244, 0xFF22FFAA, 0xFFFF22FF, 0xFF22AAFF, 0xFFFFAA22][Math.floor(rnd() * 5)] })) };
    regg.tick += .016; const pulse = Math.abs(Math.sin(regg.tick * 8));
    fillGrad(ctx, W, H, [0xFF050005, 0xFF100015, 0xFF0A0020, 0xFF050010]);
    const ballX = W * .5, ballY = H * .12, ballR = H * .07;
    circle(ctx, ballX, ballY, ballR, C(0xFF888888));
    for (let beam = 0; beam < 6; beam++) { const a = beam * Math.PI / 3 + regg.tick * 1.2, ex = ballX + Math.cos(a) * W * .7, ey = ballY + Math.sin(a) * H * .7;
      const bc = [0x33FF2244, 0x3322FFAA, 0x33FF22FF, 0x3322AAFF, 0x33FFAA22, 0x33FF66FF][beam];
      ctx.strokeStyle = linGrad(ctx, ballX, ballY, ex, ey, [bc, "rgba(0,0,0,0)"]); ctx.lineWidth = ballR * .4; line(ctx, ballX, ballY, ex, ey, ctx.strokeStyle, ballR * .4); }
    regg.discs.forEach((d, i) => { d.y -= .004; if (d.y < -.05) { d.y = 1.1; d.x = rnd(); } const alpha = .6 + .4 * Math.sin(regg.tick * 5 + i); circle(ctx, d.x * W, d.y * H, d.r * pulse, C(d.c, alpha)); });
    const spH = H * .28, spW = W * .1;
    for (let s = 0; s < 2; s++) { const spX = s === 0 ? W * .02 : W * .88, spY = H * .62, p = pulse * H * .03;
      rect(ctx, spX, spY, spX + spW, spY + spH, C(0xFF1A1A1A));
      ctx.fillStyle = radGrad(ctx, spX + spW * .5, spY + spH * .5, spW * .4 + p, [0xFF444444, 0xFF222222, 0xFF111111]); circle(ctx, spX + spW * .5, spY + spH * .5, spW * .4 + p); }
    const eq = [0xFFFF2244, 0xFFFF6622, 0xFFFFCC00, 0xFF22FF88, 0xFF22CCFF, 0xFF8822FF, 0xFFFF22CC], barW = W / eq.length;
    eq.forEach((c, b) => { const barH2 = H * .08 * pulse * (.4 + .6 * Math.abs(Math.sin(regg.tick * 6 + b * .8))); rect(ctx, b * barW + 2, H - barH2, (b + 1) * barW - 2, H, C(c)); });
  }

  // ═══ FIRESTORM ═══
  let fsP;
  function drawFirestorm() {
    if (!fsP) fsP = field(80).map(() => ({ x: rnd() * W, y: H * (.7 + rnd() * .3), s: 4 + rnd() * 14, v: 4 + rnd() * 8 }));
    fillGrad(ctx, W, H, [0xFF000000, 0xFF200000, 0xFF500000, 0xFF900000, 0xFFCC3300], [0, .25, .5, .75, 1]);
    fsP.forEach((p, i) => { p.y -= p.v; p.x += Math.sin(tick * 1.5 + i) * 3.5; p.s *= .98; if (p.y < -p.s || p.s < 1) { p.x = rnd() * W; p.y = H; p.s = 6 + rnd() * 12; }
      ctx.fillStyle = radGrad(ctx, p.x, p.y, p.s, [0xFFFF2200, 0xCCFF6600, 0x00000000]); circle(ctx, p.x, p.y, p.s); });
    ctx.fillStyle = radGrad(ctx, W * .5, H * .95, W * .5, [0xAAFFFF44, 0x00000000]); rect(ctx, 0, H * .8, W, H);
  }

  // ═══ GALAXY ═══
  let galP, galAngle = 0;
  function drawGalaxy() {
    if (!galP) galP = field(200).map((_, i) => ({ a: rnd() * Math.PI * 2, r: rnd(), s: 1 + rnd() * 2 }));
    galAngle += .003;
    fillGrad(ctx, W, H, [0xFF000010, 0xFF150025, 0xFF200035, 0xFF001540]);
    const cx = W * .5, cy = H * .5, maxR = Math.min(W, H) * .55;
    galP.forEach((p, i) => { const a = p.a + galAngle * (1.5 - p.r), r = p.r * maxR, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * .6;
      const tw = .5 + .5 * Math.sin(tick * 3 + i); circle(ctx, x, y, p.s * (1 - p.r * .5), C(0xFFFFFFFF, tw * (1 - p.r * .6))); });
    ctx.fillStyle = radGrad(ctx, cx, cy, maxR * .18, [0xFFFFEECC, 0xFFFFAACC, 0x00000000]); circle(ctx, cx, cy, maxR * .18);
  }

  // ═══ ZOMBIE ═══
  let zb;
  function drawZombie() {
    if (!zb) zb = { tick: 0, hands: field(8).map(() => ({ x: rnd(), rise: rnd() })) };
    zb.tick += .016;
    fillGrad(ctx, W, H, [0xFF0A0800, 0xFF0D0A00, 0xFF1A1200, 0xFF2A1800]);
    ctx.fillStyle = radGrad(ctx, W * .5, H * .3, W * .5, [0x88990000, 0x00000000]); rect(ctx, 0, 0, W, H);
    rect(ctx, 0, H * .8, W, H, C(0xFF1A1200));
    zb.hands.forEach((h, i) => { const rise = (Math.sin(zb.tick * .6 + i * 2) * .5 + .5), hx = h.x * W, hy = H * .8 - rise * H * .15;
      ctx.strokeStyle = C(0xFF2A1800); ctx.lineWidth = 6; line(ctx, hx, H * .9, hx, hy, C(0xFF2A1800), 6);
      ctx.fillStyle = C(0xCC001100); for (let f = 0; f < 4; f++) { const fx = hx - 8 + f * 5.3; line(ctx, fx, hy, fx, hy - 14, C(0xCC001100), 3); } });
    ctx.fillStyle = C(0xAA00FF44, .18 + .1 * Math.sin(zb.tick * 3)); rect(ctx, 0, 0, W, H);
  }

  // ═══ MEMORY LANE ═══
  function drawMemoryLane() {
    fillGrad(ctx, W, H, [0xFF0A0806, 0xFF1A1008, 0xFF2A1A10, 0xFF0D0806]);
    const cols = 3, rows = 2, pad = W * .04, pw = (W - pad * (cols + 1)) / cols, ph = H * .28;
    const photoColors = [0xFFAACC88, 0xFF88AADD, 0xFFDDAA88, 0xFFBB9966, 0xFFBB8866, 0xFFDDBB88];
    let idx = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const px = pad + c * (pw + pad), py = H * .12 + r * (ph + pad), sway = Math.sin(tick * .6 + idx) * 3;
      ctx.fillStyle = C(0xBB0D0806); rect(ctx, px + sway + 4, py + 6, px + sway + pw + 4, py + ph + 6);
      ctx.fillStyle = C(0xFFDDD5BB); rect(ctx, px + sway, py, px + sway + pw, py + ph);
      ctx.fillStyle = C(photoColors[idx % photoColors.length], .8); rect(ctx, px + sway + pw * .08, py + ph * .08, px + sway + pw * .92, py + ph * .78); idx++; }
    ctx.fillStyle = radGrad(ctx, W * .5, H * .5, W * .7, [0x00000000, 0x88FF8888]); rect(ctx, 0, 0, W, H);
  }

  // ═══ WILD WEST ═══
  let ww;
  function drawWildWest() {
    if (!ww) ww = { tick: 0, tumbleX: -.2 };
    ww.tick += .016; ww.tumbleX += .003; if (ww.tumbleX > 1.2) ww.tumbleX = -.2;
    fillGrad(ctx, W, H, [0xFFFF8C00, 0xFFCC5500, 0xFF7A3311, 0xFF1A0A00], [0, .35, .65, 1]);
    ctx.fillStyle = C(0xFF4A1800);
    ctx.beginPath(); ctx.moveTo(0, H * .68); for (let i = 0; i <= 8; i++) ctx.lineTo(W * i / 8, H * (.6 + .06 * Math.sin(i * 1.3))); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = C(0xFF3A7A22); ctx.lineWidth = 4; ctx.lineCap = "round";
    for (let cac = 0; cac < 3; cac++) { const cx = W * (.15 + cac * .35), baseY = H * .82, h = H * .12;
      line(ctx, cx, baseY, cx, baseY - h, C(0xFF3A7A22), 5); line(ctx, cx, baseY - h * .5, cx - h * .3, baseY - h * .5, C(0xFF3A7A22), 5); line(ctx, cx, baseY - h * .7, cx + h * .3, baseY - h * .7, C(0xFF3A7A22), 5); }
    ctx.lineCap = "butt";
    const tx = ww.tumbleX * W, ty = H * .88; ctx.strokeStyle = C(0xFF8A4422); ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + ww.tick * 4; line(ctx, tx, ty, tx + Math.cos(a) * 14, ty + Math.sin(a) * 14, C(0xFF8A4422), 2); }
  }

  // ═══ FANTASY ISLAND ═══
  function drawFantasyIsland() {
    fillGrad(ctx, W, H, [0xFF04002A, 0xFF1A0050, 0xFF04004A, 0xFF0A2210], [0, .35, .6, 1]);
    for (let i = 0; i < 40; i++) circle(ctx, (i * 91) % W, (i * 53) % (H * .5), 1 + (i % 3) * .5, C(0xFFFFDD44, .5 + .5 * Math.sin(tick * 2 + i)));
    ctx.fillStyle = radGrad(ctx, W * .75, H * .18, H * .1, [0xFF44FFCC, 0xFF44AAFF, 0x00000000]); circle(ctx, W * .75, H * .18, H * .1);
    for (let isl = 0; isl < 3; isl++) { const ix = W * (.2 + isl * .3), iy = H * (.55 + Math.sin(tick * .4 + isl) * .02), iw = W * .18;
      ctx.fillStyle = C(0xFF0A2210); oval(ctx, ix - iw / 2, iy, ix + iw / 2, iy + H * .05);
      ctx.fillStyle = C(0xFFFF44AA, .5); circle(ctx, ix, iy - H * .03, H * .025); }
  }

  // ═══ ARCTIC ═══
  let arcP;
  function drawArctic() {
    if (!arcP) arcP = field(100).map(() => ({ x: rnd(), y: rnd(), s: 1 + rnd() * 2.5, v: .3 + rnd() * .6 }));
    fillGrad(ctx, W, H, [0xFF020518, 0xFF050A30, 0xFF0A1040, 0xFF778899], [0, .4, .75, 1]);
    const ac = [[0x3300AAFF, 0x5500DDFF, 0x3300CCFF], [0x33BB00FF, 0x4400FFAA, 0x33AA00FF]];
    for (let r = 0; r < 2; r++) { const bY = H * (.15 + r * .1), rhh = H * .18;
      ctx.beginPath(); ctx.moveTo(0, H); for (let x = 0; x <= W; x += 10) { const t = x / W; ctx.lineTo(x, bY + rhh * (.5 + .5 * Math.sin(t * Math.PI * 2 + tick * .5 + r))); } ctx.lineTo(W, H); ctx.closePath();
      ctx.fillStyle = linGrad(ctx, 0, bY, 0, bY + rhh * 2, ac[r]); ctx.fill(); }
    ctx.fillStyle = linGrad(ctx, 0, H * .78, 0, H, [0xFFEEF4FF, 0xFFAABBCC]); rect(ctx, 0, H * .78, W, H);
    arcP.forEach(p => { p.y += p.v / H * 8; p.x += Math.sin(tick + p.y * 10) * .0006; if (p.y > 1) { p.y = 0; p.x = rnd(); } circle(ctx, p.x * W, p.y * H, p.s, C(0xDDFFFFFF)); });
  }

  // ═══ TSUNAMI ═══
  let ts;
  function drawTsunami() {
    if (!ts) ts = { tick: 0 };
    ts.tick += .016;
    fillGrad(ctx, W, H, [0xFF050A18, 0xFF0A1E40, 0xFF0A4060, 0xFF0A5580], [0, .3, .6, 1]);
    const waveH = H * (.35 + .1 * Math.sin(ts.tick * .5));
    ctx.fillStyle = linGrad(ctx, 0, H * .5 - waveH, 0, H, [0xFF2299DD, 0xFF1A80C0, 0xFF0A3050]);
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) { const curl = Math.sin(x / W * Math.PI * 1.5 + ts.tick) * waveH * .3; ctx.lineTo(x, H * .55 - waveH + curl); }
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C(0xCCEEFFFF); for (let f = 0; f < 20; f++) { const fx = W * (f / 20) + Math.sin(ts.tick * 2 + f) * 10, fy = H * .55 - waveH + Math.sin(fx / W * Math.PI * 1.5 + ts.tick) * waveH * .3; circle(ctx, fx, fy, 3); }
  }

  // ═══ THUNDERSTORM ═══
  let thP, thLight = 0, thLightTimer = 0;
  function drawThunderstorm() {
    if (!thP) thP = field(120).map(() => ({ x: rnd() * W, y: rnd() * H, l: 10 + rnd() * 20 }));
    thLightTimer += .016;
    fillGrad(ctx, W, H, [0xFF050508, 0xFF0A0A14, 0xFF10101E]);
    if (Math.random() < .006) thLight = 1;
    thLight *= .88;
    if (thLight > .05) { ctx.fillStyle = C(0xFFFFFFFF, thLight * .5); rect(ctx, 0, 0, W, H); }
    ctx.strokeStyle = C(0x3388AAFF); ctx.lineWidth = 1.4;
    thP.forEach((p, i) => { p.y += 14 + i % 5; p.x -= 3; if (p.y > H) { p.y = -20; p.x = rnd() * W; } line(ctx, p.x, p.y, p.x - 4, p.y + p.l, C(0x3388AAFF), 1.4); });
  }

  // ═══ SKYDIVING ═══
  let sd;
  function drawSkydiving() {
    if (!sd) sd = { tick: 0, clouds: field(8).map(() => ({ x: rnd(), y: .2 + rnd() * .5, s: .5 + rnd() })) };
    sd.tick += .016;
    fillGrad(ctx, W, H, [0xFF02060A, 0xFF071A44, 0xFF0A3366, 0xFF1A5599], [0, .3, .65, 1]);
    ctx.fillStyle = C(0xEEEEEEFF, .8); sd.clouds.forEach((c, i) => { c.y += .0006; if (c.y > 1) c.y = 0; cloud(c.x * W, c.y * H, W * .06 * c.s); });
    const jx = W * .5, jy = H * (.3 + .1 * Math.sin(sd.tick)); ctx.strokeStyle = C(0xBBFFFFFF); ctx.lineWidth = 1.5;
    for (let l = -1; l <= 1; l += 2) line(ctx, jx + l * 18, jy - 30, jx + l * 6, jy, C(0xBBFFFFFF), 1.5);
    ctx.fillStyle = C(0xFF224488); ctx.beginPath(); ctx.ellipse(jx, jy - 34, 26, 12, 0, Math.PI, 0); ctx.fill();
    circle(ctx, jx, jy, 5, C(0xFF0A0808));
  }

  // ═══ MOON WALK ═══
  let mw;
  function drawMoonWalk() {
    if (!mw) mw = { tick: 0, stars: field(120).map(() => ({ x: rnd() * 1, y: rnd() * 1, s: rnd() })) };
    mw.tick += .016;
    ctx.fillStyle = C(0xFF000005); rect(ctx, 0, 0, W, H);
    mw.stars.forEach((s, i) => circle(ctx, s.x * W, s.y * H * .7, .5 + s.s * 1.5, C(0xFFFFFFFF, .5 + .5 * Math.sin(mw.tick * 2 + i))));
    ctx.fillStyle = radGrad(ctx, W * .78, H * .18, H * .12, [0xFF2266CC, 0xFF114499, 0x00000000]); circle(ctx, W * .78, H * .18, H * .12);
    ctx.fillStyle = linGrad(ctx, 0, H * .7, 0, H, [0xFF888888, 0xFF505050]); rect(ctx, 0, H * .7, W, H);
    for (let i = 0; i < 10; i++) circle(ctx, (i * 137) % W, H * .7 + (i * 53) % (H * .25), 4 + (i % 3) * 3, C(0xFF6A6A6A));
    const ax = W * .5 + Math.sin(mw.tick * .5) * W * .15, ay = H * .82;
    ctx.fillStyle = C(0xFFFFFFFF); circle(ax, ay - 22, 8); rect(ctx, ax - 6, ay - 14, ax + 6, ay + 2); circle(ax, ay - 22, 9);
  }

  // ═══ BAR ═══
  let bar;
  function drawBar() {
    if (!bar) bar = { tick: 0, bubbles: field(20).map(() => ({ x: rnd(), y: rnd(), r: 2 + rnd() * 3, c: [0xCC884400, 0xCCCC8800, 0xCCFFAA22, 0xCCFFEE88][Math.floor(rnd() * 4)] })) };
    bar.tick += .016;
    fillGrad(ctx, W, H, [0xFF0D0500, 0xFF1A0A00, 0xFF2A1500, 0xFF150800]);
    ctx.fillStyle = radGrad(ctx, W * .5, H * .2, W * .5, [0x33CC8833, 0x00000000]); rect(ctx, 0, 0, W, H);
    ctx.fillStyle = linGrad(ctx, 0, H * .78, 0, H, [0xFF4A2800, 0xFF2A1500]); rect(ctx, 0, H * .78, W, H);
    ["#FF9ED8", "#AEE9FF", "#C9A8FF", "#9EFFC7", "#FFE59E"].forEach((col, i) => { const bx = W * (.12 + i * .18), bh = H * (.12 + (i % 3) * .04);
      ctx.fillStyle = col + "CC"; rect(ctx, bx, H * .78 - bh, bx + W * .04, H * .78); rect(ctx, bx - W * .006, H * .78 - bh - 8, bx + W * .046, H * .78 - bh); });
    bar.bubbles.forEach(b => { b.y -= .002; if (b.y < 0) b.y = 1; circle(ctx, b.x * W, b.y * H * .78, b.r, C(b.c)); });
  }

  // ═══ FAIRYTALE PACK ═══
  let ft;
  function drawFairytale() {
    if (!ft) ft = { tick: 0, sparkleX: field(40).map(() => rnd() * W), sparkleY: field(40).map(() => rnd() * H),
      fairyX: [W * .2, W * .5, W * .75, W * .35], fairyY: [H * .3, H * .4, H * .25, H * .55], fairyPhase: field(4).map(() => rnd() * 6.28),
      butterflyX: field(10).map(() => rnd() * W), butterflyY: field(10).map(() => rnd() * H),
      butterflyColor: [0xFFFFAACC, 0xFFAAFFCC, 0xFFAACCFF, 0xFFFFEEAA, 0xFFCCAAFF] };
    ft.tick += .016;
    fillGrad(ctx, W, H, [0xFF1B0F33, 0xFF33205C, 0xFF5C3A82, 0xFF8A5CA8], [0, .4, .75, 1]);
    ft.sparkleX.forEach((sx, i) => { const a = .25 + .55 * Math.sin(ft.tick * 2 + i); circle(ctx, sx, ft.sparkleY[i], 1.6 + (i % 3) * .8, C(0xFFFFF0D2, Math.max(0, a * .78))); });
    ctx.fillStyle = C(0xFF150A28);
    for (let t = 0; t < 4; t++) { const tx = W * (.1 + t * .28); rect(ctx, tx - 6, H * .72, tx + 6, H); circle(ctx, tx, H * .68, 46 + (t % 2) * 10); }
    for (let i = 0; i < 4; i++) { const fx = ft.fairyX[i] + Math.sin(ft.tick * 1.6 + ft.fairyPhase[i]) * W * .12, fy = ft.fairyY[i] + Math.cos(ft.tick * 1.2 + ft.fairyPhase[i]) * H * .08;
      ctx.fillStyle = radGrad(ctx, fx, fy, 14, [0xFFFFF4E0, 0x00FFFFFF]); circle(ctx, fx, fy, 14);
      ctx.fillStyle = C(0xCCFFFFFF); oval(ctx, fx - 10, fy - 4, fx - 2, fy + 4); oval(ctx, fx + 2, fy - 4, fx + 10, fy + 4); }
    for (let i = 0; i < 10; i++) { const wingFlap = Math.abs(Math.sin(ft.tick * 8 + i)), col = ft.butterflyColor[(i + Math.floor(ft.tick * .7)) % 5], bx = ft.butterflyX[i], by = ft.butterflyY[i], wingW = 10 + wingFlap * 6;
      ctx.fillStyle = C(col); oval(ctx, bx - wingW, by - 8, bx - 2, by + 8); oval(ctx, bx + 2, by - 8, bx + wingW, by + 8); }
  }

  let wc2;
  function drawWitch() {
    if (!wc2) wc2 = { tick: 0, bubbleTimer: 0, smoke: field(20).map((_, i) => ({ x: W * .5, y: H * .62, s: 4 + rnd() * 10, a: rnd(), hue: i % 6 })),
      bats: field(5).map(() => ({ x: rnd() * W, y: H * (.08 + rnd() * .18), phase: rnd() * 6.28 })) };
    wc2.tick += .016; wc2.bubbleTimer += .016;
    fillGrad(ctx, W, H, [0xFF07040F, 0xFF120A20, 0xFF1E1030], [0, .55, 1]);
    ctx.fillStyle = radGrad(ctx, W * .78, H * .14, H * .09, [0xFFE8E4C8, 0xFFB9B49A, 0x00000000]); circle(ctx, W * .78, H * .14, H * .09);
    ctx.fillStyle = C(0xFF120A18);
    wc2.bats.forEach((b, i) => { let bx = b.x + Math.sin(wc2.tick * .9 + b.phase) * W * .02 + wc2.tick * 6 * (1 + i % 2); bx = ((bx % (W + 60)) + (W + 60)) % (W + 60) - 30;
      const by = b.y + Math.sin(wc2.tick * 4 + b.phase) * 8, flap = Math.sin(wc2.tick * 10 + i) * 8;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(bx - 14, by - 10 - flap, bx - 22, by); ctx.quadraticCurveTo(bx - 12, by + 3, bx, by);
      ctx.quadraticCurveTo(bx + 12, by + 3, bx + 22, by); ctx.quadraticCurveTo(bx + 14, by - 10 - flap, bx, by); ctx.fill(); });
    const cauX = W * .58, cauY = H * .62; ctx.fillStyle = C(0xFF1A1A1A); oval(ctx, cauX - W * .16, cauY - H * .015, cauX + W * .16, cauY + H * .09);
    const bubble = .5 + .5 * Math.sin(wc2.bubbleTimer * 6);
    ctx.fillStyle = radGrad(ctx, cauX, cauY - H * .01, W * .12, [0xFF8CFF66, 0xFF2E8C1F, 0x00000000]); oval(ctx, cauX - W * .13, cauY - H * .02, cauX + W * .13, cauY + H * .015);
    const smokeHues = [0xFF66FF99, 0xFFFF66C4, 0xFF66C4FF, 0xFFFFD666, 0xFFB166FF, 0xFF66FFE0];
    wc2.smoke.forEach(s => { s.y -= 1.1; s.x += Math.sin(wc2.tick * 1.5) * 1.3; s.a -= .006; if (s.y < H * .05 || s.a <= 0) { s.y = H * .62; s.x = cauX + (rnd() - .5) * W * .08; s.a = .85; s.hue = (s.hue + 1) % 6; }
      circle(ctx, s.x, s.y, s.s, C(smokeHues[s.hue], Math.max(0, s.a * .55))); });
  }

  let rr;
  function heart(cx, cy, size, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(cx, cy + size * .3);
    ctx.bezierCurveTo(cx - size, cy - size * .6, cx - size * .4, cy - size * 1.2, cx, cy - size * .4);
    ctx.bezierCurveTo(cx + size * .4, cy - size * 1.2, cx + size, cy - size * .6, cx, cy + size * .3); ctx.fill(); }
  function drawRomanceRnb() {
    if (!rr) rr = { tick: 0, pulse: 0, petals: field(16).map(() => ({ x: rnd() * W, y: rnd() * H, rot: rnd() * 360 })) };
    rr.tick += .016; rr.pulse += .02;
    fillGrad(ctx, W, H, [0xFF1A0410, 0xFF3D0A22, 0xFF6E1238, 0xFF3D0A22], [0, .35, .65, 1]);
    ctx.fillStyle = radGrad(ctx, W * .5, H * .35, W * .55, [0x55FF7099, 0x00000000]); circle(ctx, W * .5, H * .35, W * .55);
    const pulse = .85 + .15 * Math.sin(rr.pulse * 2);
    for (let i = 0; i < 4; i++) heart(W * (.15 + i * .24), H * (.78 + .03 * Math.sin(rr.tick + i)), 16 * pulse, C(0xFFFF7096, .39));
    rr.petals.forEach(p => { p.y += .7; p.x += Math.sin(rr.tick + p.rot) * .8; p.rot += .6; if (p.y > H + 20) { p.y = -20; p.x = rnd() * W; }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot * Math.PI / 180); ctx.fillStyle = C(0xFFE85A82); oval(ctx, -5, -3, 5, 3); ctx.restore(); });
  }

  let hh;
  function drawHipHop() {
    if (!hh) hh = { tick: 0, bars: field(20).map(() => .5) };
    hh.tick += .016; hh.bars = hh.bars.map((_, i) => .25 + .7 * Math.abs(Math.sin(hh.tick * (2.5 + (i % 4) * .7) + i)));
    fillGrad(ctx, W, H, [0xFF06070C, 0xFF15121F, 0xFF241033], [0, .5, 1]);
    ctx.fillStyle = C(0xFF0C0A14);
    for (let i = 0; i < 9; i++) { const bx = W * i / 9, bw = W / 9 * .7, bh = H * (.28 + (i % 4) * .08); rect(ctx, bx, H - bh, bx + bw, H); }
    ctx.fillStyle = C(0xAAFFD24C);
    for (let i = 0; i < 9; i++) { const bx = W * i / 9, bw = W / 9 * .7, bh = H * (.28 + (i % 4) * .08);
      for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) { if ((i * 7 + r * 3 + c) % 3 !== 0) continue; rect(ctx, bx + 6 + c * (bw / 3), H - bh + 10 + r * 16, bx + 12 + c * (bw / 3), H - bh + 20 + r * 16); } }
    const neon = [0xFFFF2E9A, 0xFF2EE6FF, 0xFFFFE22E];
    const barW = W * .85 / hh.bars.length;
    hh.bars.forEach((v, i) => { const bx = W * .075 + i * barW, bh = H * .22 * v; ctx.fillStyle = linGrad(ctx, 0, H * .9 - bh, 0, H * .9, [neon[i % 3], 0x33000000]); rect(ctx, bx, H * .9 - bh, bx + barW * .7, H * .9); });
  }

  let bb;
  function drawBabylon() {
    if (!bb) bb = { tick: 0 };
    bb.tick += .016;
    fillGrad(ctx, W, H, [0xFF2A1400, 0xFF6B3A0F, 0xFFC97C2E, 0xFFF4C879], [0, .35, .7, 1]);
    ctx.fillStyle = radGrad(ctx, W * .5, H * .22, H * .12, [0xFFFFF3C4, 0xFFFFC94C, 0x00000000]); circle(ctx, W * .5, H * .22, H * .12);
    ctx.fillStyle = C(0xFF3A2210);
    for (let s = 0; s < 5; s++) { const w2 = W * (.5 - s * .06), h2 = H * (.34 - s * .045); rect(ctx, W * .5 - w2 / 2, h2, W * .5 + w2 / 2, h2 + H * .045); }
    ctx.fillStyle = C(0xFF3D5A24);
    for (let side = -1; side <= 1; side += 2) for (let t = 0; t < 4; t++) { const tx = W * .5 + side * (W * .28 + t * W * .05), ty = H * (.5 + t * .08); oval(ctx, tx - 30, ty - 12, tx + 30, ty + 12); }
    for (let i = 0; i < 6; i++) { const tx = W * (.08 + i * .17), ty = H * .86, fl = .7 + .3 * Math.sin(bb.tick * 9 + i * 1.7);
      rect(ctx, tx - 3, ty, tx + 3, ty + H * .08, C(0xFF3A2210)); ctx.fillStyle = radGrad(ctx, tx, ty - 6, 18 * fl, [0xFFFFE08A, 0xFFFF7A1A, 0x00000000]); circle(ctx, tx, ty - 6, 18 * fl); }
  }

  let sn;
  function drawSwordNight() {
    if (!sn) sn = { tick: 0, glintTimer: 0, embers: field(20).map(() => ({ x: rnd() * W, y: H * (.7 + rnd() * .3), s: 1 + rnd() * 3 })) };
    sn.tick += .016; sn.glintTimer += .016;
    fillGrad(ctx, W, H, [0xFF03030A, 0xFF0A0A18, 0xFF14141F], [0, .55, 1]);
    ctx.fillStyle = radGrad(ctx, W * .82, H * .12, H * .08, [0xFFDCE6FF, 0xFF9AAAD0, 0x00000000]); circle(ctx, W * .82, H * .12, H * .08);
    ctx.fillStyle = C(0xFF05050A); rect(ctx, 0, H * .62, W, H);
    for (let t = 0; t < 5; t++) { const tx = W * (.05 + t * .22); rect(ctx, tx, H * .48, tx + W * .08, H * .64, C(0xFF05050A)); }
    ctx.fillStyle = C(0xFF8A1020);
    for (let b = 0; b < 3; b++) { const bx = W * (.16 + b * .22), wave = Math.sin(sn.tick * 2 + b) * 6;
      ctx.beginPath(); ctx.moveTo(bx, H * .49); ctx.lineTo(bx + 18 + wave, H * .49 + 6); ctx.lineTo(bx, H * .58); ctx.closePath(); ctx.fill(); }
    const glint = .5 + .5 * Math.sin(sn.glintTimer * 4);
    ctx.strokeStyle = C(0xFFB8C4E0); ctx.lineWidth = 6; ctx.lineCap = "round";
    line(ctx, W * .38, H * .40, W * .62, H * .30, C(0xFFB8C4E0), 6); line(ctx, W * .62, H * .40, W * .38, H * .30, C(0xFFB8C4E0), 6); ctx.lineCap = "butt";
    circle(ctx, W * .5, H * .35, 10 * glint, C(0xFFFFFFFF, glint * .7));
    sn.embers.forEach((e, i) => circle(ctx, e.x, e.y -= 0, e.s, `rgba(255,${150 + (i % 3) * 20},60,.7)`));
  }

  let ds;
  function drawDrStrange() {
    if (!ds) ds = { tick: 0, ringRot: 0, sparks: field(12).map(() => ({ angle: rnd() * 6.28, r: .15 + rnd() * .28 })) };
    ds.tick += .016; ds.ringRot += .02;
    ctx.fillStyle = C(0xFF06030A); rect(ctx, 0, 0, W, H);
    const cx = W * .5, cy = H * .48;
    for (let ring = 3; ring >= 1; ring--) { const r = Math.min(W, H) * .12 * ring; ctx.strokeStyle = C(0xFFFF9628, (180 - ring * 30) / 255); ctx.lineWidth = 3;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate((ring % 2 === 0 ? ds.ringRot : -ds.ringRot) * (60 / ring));
      for (let seg = 0; seg < 16; seg++) { const a = seg * Math.PI * 2 / 16; line(ctx, Math.cos(a) * r, Math.sin(a) * r, Math.cos(a) * (r + 10), Math.sin(a) * (r + 10), ctx.strokeStyle, 3); } ctx.restore(); }
    ctx.fillStyle = radGrad(ctx, cx, cy, Math.min(W, H) * .14, [0xFFFFF3C4, 0xFFFFA23C, 0xFF7A2E00, 0x00000000], [0, .3, .7, 1]); circle(ctx, cx, cy, Math.min(W, H) * .14);
    ds.sparks.forEach((s, i) => { const a = s.angle + ds.tick * (1.2 + (i % 3) * .3), r = Math.min(W, H) * s.r; circle(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.2, C(0xFFFFC864)); });
  }

  let lotr = { tick: 0, eagleX: -.2, mistPhase: 0 };
  function drawLotr() {
    lotr.tick += .016; lotr.eagleX += .0015; if (lotr.eagleX > 1.2) lotr.eagleX = -.2; lotr.mistPhase += .01;
    fillGrad(ctx, W, H, [0xFF7FA6C9, 0xFFA9C7A0, 0xFF5C8A52, 0xFF2E4A28], [0, .35, .7, 1]);
    ctx.fillStyle = C(0x8C82960A, .55);
    ctx.beginPath(); ctx.moveTo(0, H * .42); for (let i = 0; i <= 8; i++) ctx.lineTo(W * i / 8, H * (.32 + .1 * Math.abs(Math.sin(i * 1.7 + lotr.mistPhase)))); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C(0xFF3C6B34);
    ctx.beginPath(); ctx.moveTo(0, H * .78); for (let i = 0; i <= 10; i++) ctx.lineTo(W * i / 10, H * (.7 + .06 * Math.sin(i * 1.1))); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
    rect(ctx, W * .74 - 3, H * .68, W * .74 + 3, H * .76, C(0xFF23401D)); circle(ctx, W * .74, H * .66, 20, C(0xFF23401D));
    ctx.fillStyle = C(0xFF201808); const ex = W * lotr.eagleX, ey = H * (.2 + .03 * Math.sin(lotr.tick * 2)), flap = Math.sin(lotr.tick * 3) * 10;
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.quadraticCurveTo(ex - 26, ey - 10 - flap, ex - 44, ey - 2); ctx.quadraticCurveTo(ex - 20, ey + 4, ex, ey);
    ctx.quadraticCurveTo(ex + 20, ey + 4, ex + 44, ey - 2); ctx.quadraticCurveTo(ex + 26, ey - 10 - flap, ex, ey); ctx.fill();
    const glow = .4 + .3 * Math.sin(lotr.tick * 1.5); ctx.fillStyle = radGrad(ctx, W * .5, H * .93, 22, [`rgba(255,210,90,${glow * .78})`, "rgba(0,0,0,0)"]); circle(ctx, W * .5, H * .93, 22);
  }

  let arc;
  function drawArcane() {
    if (!arc) arc = { tick: 0, arcTimer: 0, runes: field(10).map(() => ({ x: rnd() * W, y: rnd() * H, phase: rnd() * 6.28 })) };
    arc.tick += .016; arc.arcTimer += .016;
    fillGrad(ctx, W, H, [0xFF040414, 0xFF0E1030, 0xFF1C1040, 0xFF2A0F3A], [0, .4, .75, 1]);
    ctx.fillStyle = C(0xFF0A0A1A);
    for (let i = 0; i < 7; i++) { const bx = W * i / 7, bw = W / 7 * .75, bh = H * (.3 + (i % 3) * .1); rect(ctx, bx, H - bh, bx + bw, H); }
    ctx.fillStyle = C(0x8833E6FF); for (let i = 0; i < 7; i++) { const bx = W * i / 7, bh = H * (.3 + (i % 3) * .1); rect(ctx, bx + 4, H - bh + 4, bx + 10, H); }
    arc.runes.forEach(r => { const ry = r.y + Math.sin(arc.tick * 1.3 + r.phase) * 10, pulse = .6 + .4 * Math.sin(arc.tick * 2 + r.phase);
      ctx.strokeStyle = C(0xFF78DCFF, pulse * .63); ctx.lineWidth = 2; ctx.strokeRect(r.x - 6, ry - 6, 12, 12); ctx.beginPath(); ctx.arc(r.x, ry, 9, 0, Math.PI * 2); ctx.stroke(); });
    const arcPulse = Math.abs(Math.sin(arc.arcTimer * 6));
    ctx.fillStyle = radGrad(ctx, W * .28, H * .3, 22, [0xFFB47CFF, 0x00000000]); circle(ctx, W * .28, H * .3, 22);
    ctx.fillStyle = radGrad(ctx, W * .72, H * .32, 22, [0xFF7CE0FF, 0x00000000]); circle(ctx, W * .72, H * .32, 22);
    if (arcPulse > .5) { ctx.strokeStyle = C(0xCCE0C4FF); ctx.lineWidth = 2.5; const mx = (W * .28 + W * .72) / 2;
      ctx.beginPath(); ctx.moveTo(W * .28, H * .3); ctx.lineTo(mx + rnd() * 20 - 10, H * .28); ctx.lineTo(W * .72, H * .32); ctx.stroke(); }
  }

  let sw;
  function drawStarWars() {
    if (!sw) sw = { tick: 0, stars: field(140).map(() => ({ x: (rnd() - .5) * W, y: (rnd() - .5) * H, z: rnd() * W })) };
    sw.tick += .016;
    ctx.fillStyle = C(0xFF000005); rect(ctx, 0, 0, W, H);
    const cx = W * .5, cy = H * .5;
    ctx.strokeStyle = C(0xFFFFFFFF); ctx.lineCap = "round";
    sw.stars.forEach(s => { s.z -= 14; if (s.z < 1) { s.z = W; s.x = (rnd() - .5) * W; s.y = (rnd() - .5) * H; }
      const k = W * .5 / s.z, sx = cx + s.x * k, sy = cy + s.y * k, prevK = W * .5 / Math.min(W, s.z + 26), px2 = cx + s.x * prevK, py2 = cy + s.y * prevK;
      if (sx < 0 || sx > W || sy < 0 || sy > H) return;
      ctx.lineWidth = Math.max(1, 3 * (1 - s.z / W)); ctx.globalAlpha = 1 - s.z / W; ctx.beginPath(); ctx.moveTo(px2, py2); ctx.lineTo(sx, sy); ctx.stroke(); });
    ctx.globalAlpha = 1;
    circle(ctx, W * .82, H * .18, H * .07, C(0xFF2A2E36)); circle(ctx, W * .82 - H * .025, H * .18 - H * .015, H * .018, C(0xFF15171C));
    const swing = Math.sin(sw.tick * 2) * 14;
    ctx.strokeStyle = C(0xFF4DA8FF); ctx.lineWidth = 5; ctx.lineCap = "round"; line(ctx, W * .3, H * .82, W * .58 + swing, H * .58, C(0xFF4DA8FF), 5);
    ctx.strokeStyle = C(0xFFFF3B3B); line(ctx, W * .7, H * .82, W * .42 - swing, H * .58, C(0xFFFF3B3B), 5); ctx.lineCap = "butt";
    ctx.fillStyle = radGrad(ctx, W * .5, H * .70, 16, [0xAAFFFFFF, 0x00000000]); circle(ctx, W * .5, H * .70, 16);
  }

  const DRAW = {
    waves: drawWaves, volcano: drawVolcano, sunset: drawSunset, windmill: drawWindmill, waterfall: drawWaterfall,
    undersea: drawUndersea, smoke: drawSmoke, piano: drawPiano, thinking: drawThinking, aurora: drawAurora,
    shark: drawShark, dog: drawDog, cat: drawCat, sahara: drawSahara, darkness: drawDarkness, letter: drawLetter,
    beach: drawBeach, jamaica: drawJamaica, reggaeton: drawReggaeton, firestorm: drawFirestorm, galaxy: drawGalaxy,
    zombie: drawZombie, memoryLane: drawMemoryLane, wildWest: drawWildWest, fantasyIsland: drawFantasyIsland,
    arctic: drawArctic, tsunami: drawTsunami, thunderstorm: drawThunderstorm, skydiving: drawSkydiving,
    moonWalk: drawMoonWalk, bar: drawBar, fairytale: drawFairytale, witch: drawWitch, romanceRnb: drawRomanceRnb,
    hiphop: drawHipHop, babylon: drawBabylon, swordNight: drawSwordNight, drStrange: drawDrStrange, lotr: drawLotr,
    arcane: drawArcane, starWars: drawStarWars,
  };

  function resize() {
    if (!canvas) return;
    W = canvas.width = canvas.clientWidth; H = canvas.height = canvas.clientHeight;
  }
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!ctx || W === 0 || H === 0) return;
    tick += 0.016;
    if (current === "none") { ctx.clearRect(0, 0, W, H); return; }
    const fn = DRAW[current];
    if (fn) { try { fn(); } catch (e) { /* keep the loop alive even if one theme errors */ } }
  }
  function init(canvasEl) {
    canvas = canvasEl; ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
    if (!raf) frame();
  }
  function setTheme(id) { current = DRAW[id] ? id : "none"; }
  function getTheme() { return current; }

  return { init, setTheme, getTheme, THEME_LIST };
})();

/* ---------------------------------------------------------------------
   PixieDustView port — sparkle burst overlay, triggered on taps
   --------------------------------------------------------------------- */
const PixieDust = (function () {
  const SPARKLE_COLORS = [0xFFFFE9A8, 0xFFFFC1E3, 0xFFB8E6FF, 0xFFD8B8FF, 0xFFFFFFFF];
  let canvas, ctx, W = 0, H = 0, motes = [], looping = false, raf = null;
  function resize() { if (!canvas) return; W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  function init(canvasEl) { canvas = canvasEl; ctx = canvas.getContext("2d"); resize(); window.addEventListener("resize", resize); }
  function burst(x, y) {
    for (let i = 0; i < 16; i++) {
      const ang = Math.random() * Math.PI * 2, speed = 1.5 + Math.random() * 3.5;
      motes.push({ x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed - 1.2, size: 2 + Math.random() * 3.5,
        life: .55 + Math.random() * .35, age: 0, phase: Math.random() * 6.28, color: SPARKLE_COLORS[Math.floor(Math.random() * 5)] });
    }
    if (!looping) { looping = true; loop(); }
  }
  function burstFromEl(el) { const r = el.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2); }
  function loop() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    for (let i = motes.length - 1; i >= 0; i--) {
      const m = motes[i]; m.age += 0.016;
      if (m.age >= m.life) { motes.splice(i, 1); continue; }
      m.x += m.vx; m.y += m.vy; m.vy += 0.03; m.vx *= 0.97; m.vy *= 0.97;
      const lifeFrac = 1 - m.age / m.life, twinkle = .6 + .4 * Math.sin(m.age * 22 + m.phase);
      const alpha = Math.max(0, Math.min(1, lifeFrac * twinkle));
      ctx.fillStyle = radGrad(ctx, m.x, m.y, m.size * 2.2, [C(m.color, alpha), C(m.color, 0)]);
      circle(ctx, m.x, m.y, m.size * 2.2);
    }
    if (motes.length) raf = requestAnimationFrame(loop); else looping = false;
  }
  return { init, burst, burstFromEl };
})();

/* ---------------------------------------------------------------------
   BookTransitionView port — storybook double-door page-turn overlay
   --------------------------------------------------------------------- */
const BookTransition = (function () {
  let el;
  function init(elementId) { el = document.getElementById(elementId); }
  function play() {
    if (!el) return;
    el.classList.remove("book-playing"); void el.offsetWidth; // restart animation
    el.classList.add("book-playing");
    el.style.display = "flex";
    setTimeout(() => { el.style.display = "none"; }, 700);
  }
  return { init, play };
})();

/* ---------------------------------------------------------------------
   GlobeTitleView port — "VVYNAS VANE" letters orbiting a sphere
   --------------------------------------------------------------------- */
const GlobeTitle = (function () {
  const TITLE = "VVYNASVANE";
  let canvas, ctx, W = 0, H = 0, angle = 0, raf = null;
  function resize() { if (!canvas) return; W = canvas.width = canvas.clientWidth; H = canvas.height = canvas.clientHeight; }
  function init(canvasEl) { canvas = canvasEl; ctx = canvas.getContext("2d"); resize(); window.addEventListener("resize", resize); if (!raf) frame(); }
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!ctx || W === 0 || H === 0) return;
    angle += 0.008;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, rGlobe = Math.min(W * .22, H * .38);
    ctx.strokeStyle = C(0x35C9A84C); ctx.lineWidth = 1.8; ctx.beginPath(); ctx.arc(cx, cy, rGlobe, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = C(0x18C9A84C); ctx.lineWidth = 1;
    [.45, .7].forEach(k => { ctx.beginPath(); ctx.ellipse(cx, cy, rGlobe, rGlobe * k, 0, 0, Math.PI * 2); ctx.stroke(); });
    const n = TITLE.length;
    const letters = TITLE.split("").map((ch, i) => {
      const lon = (angle + (2 * Math.PI / n) * i);
      const depth = Math.cos(lon); // -1 behind, 1 in front
      const x = cx + Math.sin(lon) * (rGlobe * 1.25);
      const y = cy;
      const scale = 0.55 + 0.55 * ((depth + 1) / 2);
      const alpha = 0.25 + 0.75 * ((depth + 1) / 2);
      return { ch, x, y, scale, alpha, depth };
    }).sort((a, b) => a.depth - b.depth);
    letters.forEach(l => {
      ctx.font = `700 ${14 * l.scale}px 'Courier New', monospace`;
      ctx.fillStyle = C(0xFFF5E6C8, l.alpha);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(l.ch, l.x, l.y);
    });
  }
  return { init };
})();

/* ---------------------------------------------------------------------
   Public export
   --------------------------------------------------------------------- */
global.VV = {
  idbGet, idbSet, idbDelete, idbGetAll, idbGetAllKeys, idbGetAllEntries, idbPut,
  openDB,
  FONTS, applyFont,
  fsApiSupported, verifyPermission, pickDirectory, getStoredHandle, walkDirectory, AUDIO_EXT,
  ThemeEngine, PixieDust, BookTransition, GlobeTitle,
  C, linGrad, radGrad, fillGrad,
  generatedArt, hashStr, setArtStyle, getArtStyle, ART_STYLES, drawSkullIcon,
  resizeImageFileToDataUrl, extractRawPictureBlob, getEmbeddedArtForFile,
};

})(window);
