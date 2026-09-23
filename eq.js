/* =========================================================================
   VVYNAS VANE — EQUALIZER + SHARED AUDIO GRAPH   (window.VaneEQ)

   One Web Audio graph per page, owned here. A media element can only ever
   be handed to createMediaElementSource() ONCE, so anything that wants to
   listen to (or shape) the sound — the equalizer, Rage Mode's beat
   reactivity, the lyrics glow — has to share this single graph instead of
   building its own.

     media → inTrim ─┬─ dry ────────────────────────────────────────┐
                     └─ wet → preamp → tone(3) → bands(10)          │
                          → mid/side width + balance                │
                          → (+ reverb send) → night leveler         │
                          → safety limiter ─────────────────────────┤
                                                                    ▼
                                              master → speakers
                                                     ├→ beat analyser  (Rage Mode / lyrics glow)
                                                     └→ spectrum analyser (EQ display)

   • Transparent by default: with every control at its default (or the EQ
     switched off) audio takes the `dry` path and the wet chain is even
     disconnected, so "Reset" gives you back the untouched sound.
   • The response curve on screen is computed with the same RBJ biquad
     maths Web Audio uses, so it works before any audio context exists.
   • Settings persist in IndexedDB (kv → "eq"), shared with video.html.
   ========================================================================= */
(function (global) {
"use strict";

/* ---------------------------------------------------------------------
   Model
   --------------------------------------------------------------------- */
const FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const BAND_TYPES = ["lowshelf", "peaking", "peaking", "peaking", "peaking", "peaking", "peaking", "peaking", "peaking", "highshelf"];
const BAND_Q = 1.41;                 // ~1 octave per band
const BAND_RANGE = 12;               // ±dB per band
const TONE_RANGE = 10;               // ±dB for Bass / Mid / Treble
const TONE_FILTERS = [
  { key: "bass",   type: "lowshelf",  f: 110,  q: 0.7 },
  { key: "mid",    type: "peaking",   f: 1600, q: 0.7 },
  { key: "treble", type: "highshelf", f: 7500, q: 0.7 },
];
const REVERB_SIZES = {
  studio:    { label: "Studio",    seconds: 0.9, decay: 3.2 },
  hall:      { label: "Hall",      seconds: 2.2, decay: 2.6 },
  cathedral: { label: "Cathedral", seconds: 4.2, decay: 2.1 },
};
const VIEW_DB = 15;                  // curve display range ±dB
const FREQ_LABEL = (f) => (f >= 1000 ? (f / 1000) + "k" : String(f));

const SOUND_KEYS = ["bands", "preamp", "tone", "width", "reverb", "reverbSize", "leveler"];

function defaultSound() {
  return {
    bands: FREQS.map(() => 0),
    preamp: 0,
    tone: { bass: 0, mid: 0, treble: 0 },
    width: 100,          // % — 0 = mono, 100 = as recorded, 200 = extra wide
    reverb: 0,           // % wet
    reverbSize: "hall",
    leveler: 0,          // % night-mode evening-out
  };
}
function defaultState() {
  return Object.assign(defaultSound(), {
    v: 1, enabled: true, preset: "flat", autoHeadroom: true, balance: 0, custom: [],
  });
}

/* Presets. `bands` are dB for 31 Hz … 16 kHz; anything else a preset sets
   (tone / width / reverb / leveler) is layered over the defaults. */
const PRESETS = [
  { id: "flat",      name: "Flat",            icon: "⚖", hint: "Sound untouched", bands: [0,0,0,0,0,0,0,0,0,0] },
  { id: "bass",      name: "Bass Boost",      icon: "🔊", hint: "Deeper low end", bands: [6,5,4,2,0,0,0,0,0,0] },
  { id: "bassless",  name: "Bass Reducer",    icon: "🔉", hint: "Tames boomy speakers", bands: [-6,-5,-3,-1,0,0,0,0,0,0] },
  { id: "treble",    name: "Treble Boost",    icon: "✨", hint: "Brighter, airier", bands: [0,0,0,0,0,1,2,4,5,6] },
  { id: "vocal",     name: "Vocal Boost",     icon: "🎤", hint: "Voices forward", bands: [-2,-2,-1,0,1,3,4,3,1,0] },
  { id: "rock",      name: "Rock",            icon: "🎸", hint: "Punchy, scooped mids", bands: [5,4,3,1,-1,-1,1,3,4,5] },
  { id: "pop",       name: "Pop",             icon: "🎧", hint: "Warm and present", bands: [-1,1,3,4,3,0,-1,-1,1,2] },
  { id: "hiphop",    name: "Hip-Hop",         icon: "🎛", hint: "Heavy sub, crisp hats", bands: [6,5,3,3,-1,-1,1,-1,2,3] },
  { id: "edm",       name: "Electronic",      icon: "⚡", hint: "Big lows, sparkling highs", bands: [5,4,1,0,-2,2,1,2,5,6], width: 125 },
  { id: "jazz",      name: "Jazz",            icon: "🎷", hint: "Smooth, natural", bands: [3,2,1,2,-2,-2,0,1,3,4] },
  { id: "classical", name: "Classical",       icon: "🎻", hint: "Airy with a touch of hall", bands: [3,2,1,1,0,0,0,1,2,3], reverb: 14, reverbSize: "hall" },
  { id: "acoustic",  name: "Acoustic",        icon: "🪕", hint: "Wooden warmth", bands: [4,4,3,1,1,1,2,3,3,2] },
  { id: "lounge",    name: "Lounge",          icon: "🛋", hint: "Mellow mids", bands: [-2,-1,0,2,3,2,0,-1,1,2] },
  { id: "warm",      name: "Warm & Smooth",   icon: "🔥", hint: "Softens harsh highs", bands: [2,2,1,0,0,-1,-2,-3,-3,-2] },
  { id: "loudness",  name: "Quiet Loudness",  icon: "🌙", hint: "Full sound at low volume", bands: [6,4,0,0,-1,0,-1,0,3,5] },
  { id: "phone",     name: "Small Speakers",  icon: "📱", hint: "Phone, laptop, tiny Bluetooth", bands: [-5,-3,0,3,3,1,0,1,2,2] },
  { id: "live",      name: "Live Concert",    icon: "🎪", hint: "Wide and spacious", bands: [3,2,1,0,0,1,2,3,3,2], width: 135, reverb: 22, reverbSize: "hall" },
  { id: "rage",      name: "Rage Pit",        icon: "🩸", hint: "Crushing lows, cutting top", bands: [8,7,4,1,-3,-1,2,4,5,4], width: 120 },
  { id: "podcast",   name: "Podcast / Speech", icon: "🎙", hint: "Clear, even voices", bands: [-6,-5,-3,0,2,4,4,2,-1,-3], leveler: 40 },
  { id: "night",     name: "Late Night",      icon: "🛌", hint: "Loud parts down, quiet parts up", bands: [-2,-1,0,0,0,0,1,1,0,-1], leveler: 75 },
  { id: "clarity",   name: "Clarity Lift",    icon: "🦻", hint: "Easier on high-frequency hearing loss", bands: [-1,0,0,0,1,3,5,7,8,7], leveler: 25 },
  { id: "mono",      name: "One-Ear Mono",    icon: "👂", hint: "Both channels in each ear", bands: [0,0,0,0,0,0,0,0,0,0], width: 0 },
];
const PRESET_BY_ID = new Map(PRESETS.map(p => [p.id, p]));

function presetSound(p) {
  const s = defaultSound();
  s.bands = p.bands.slice();
  ["preamp", "width", "reverb", "reverbSize", "leveler"].forEach(k => { if (p[k] !== undefined) s[k] = p[k]; });
  if (p.tone) s.tone = Object.assign(s.tone, p.tone);
  return s;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);

/** Never trust what comes out of storage: coerce into a valid state. */
function sanitize(raw) {
  const d = defaultState();
  if (!raw || typeof raw !== "object") return d;
  const s = d;
  s.enabled = raw.enabled !== false;
  s.preset = typeof raw.preset === "string" ? raw.preset : "flat";
  s.autoHeadroom = raw.autoHeadroom !== false;
  if (Array.isArray(raw.bands)) s.bands = FREQS.map((_, i) => clamp(num(raw.bands[i], 0), -BAND_RANGE, BAND_RANGE));
  s.preamp = clamp(num(raw.preamp, 0), -12, 12);
  if (raw.tone && typeof raw.tone === "object") {
    ["bass", "mid", "treble"].forEach(k => { s.tone[k] = clamp(num(raw.tone[k], 0), -TONE_RANGE, TONE_RANGE); });
  }
  s.width = clamp(num(raw.width, 100), 0, 200);
  s.balance = clamp(num(raw.balance, 0), -100, 100);
  s.reverb = clamp(num(raw.reverb, 0), 0, 100);
  s.reverbSize = REVERB_SIZES[raw.reverbSize] ? raw.reverbSize : "hall";
  s.leveler = clamp(num(raw.leveler, 0), 0, 100);
  if (Array.isArray(raw.custom)) {
    s.custom = raw.custom.filter(c => c && typeof c.id === "string" && typeof c.name === "string" && c.sound)
      .slice(0, 12).map(c => ({ id: c.id, name: c.name.slice(0, 24), sound: sanitizeSound(c.sound) }));
  }
  return s;
}
function sanitizeSound(raw) {
  const t = sanitize(Object.assign({}, raw));
  const out = {}; SOUND_KEYS.forEach(k => { out[k] = t[k]; });
  return out;
}
function isNeutral(s) {
  return s.bands.every(b => Math.abs(b) < 0.01) && Math.abs(s.preamp) < 0.01 &&
    Math.abs(s.tone.bass) < 0.01 && Math.abs(s.tone.mid) < 0.01 && Math.abs(s.tone.treble) < 0.01 &&
    Math.round(s.width) === 100 && Math.round(s.balance) === 0 && s.reverb < 0.5 && s.leveler < 0.5;
}
function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

/* ---------------------------------------------------------------------
   Filter maths (RBJ cookbook — identical to the Web Audio biquad spec)
   --------------------------------------------------------------------- */
function biquadCoeffs(type, f0, gainDb, q, fs) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / fs, cos = Math.cos(w0), sin = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === "peaking") {
    const alpha = sin / (2 * q);
    b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
  } else {
    const alpha = sin / 2 * Math.SQRT2;            // shelf slope S = 1
    const sq = 2 * Math.sqrt(A) * alpha;
    if (type === "lowshelf") {
      b0 = A * ((A + 1) - (A - 1) * cos + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - sq);
      a0 = (A + 1) + (A - 1) * cos + sq;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - sq;
    } else { // highshelf
      b0 = A * ((A + 1) + (A - 1) * cos + sq);
      b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - sq);
      a0 = (A + 1) - (A - 1) * cos + sq;
      a1 = 2 * ((A - 1) - (A + 1) * cos);
      a2 = (A + 1) - (A - 1) * cos - sq;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
/** |H(e^jw)| in dB for one filter at frequency f. */
function biquadDb(c, f, fs) {
  const w = 2 * Math.PI * f / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2,    di = -(c.a1 * s1 + c.a2 * s2);
  const mag = Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  return 20 * Math.log10(Math.max(mag, 1e-9));
}
/** Combined response of bands + tone filters (preamp excluded) at each freq. */
function compositeDb(s, freqs, fs) {
  fs = fs || 48000;
  const out = new Float64Array(freqs.length);
  const filters = [];
  s.bands.forEach((g, i) => { if (Math.abs(g) > 0.01) filters.push(biquadCoeffs(BAND_TYPES[i], FREQS[i], g, BAND_Q, fs)); });
  TONE_FILTERS.forEach(t => { const g = s.tone[t.key]; if (Math.abs(g) > 0.01) filters.push(biquadCoeffs(t.type, t.f, g, t.q, fs)); });
  if (!filters.length) return out;
  for (let i = 0; i < freqs.length; i++) {
    let db = 0; for (let k = 0; k < filters.length; k++) db += biquadDb(filters[k], freqs[i], fs);
    out[i] = db;
  }
  return out;
}
const LOG_GRID = (() => { const n = 160, a = Math.log10(20), b = Math.log10(20000); return Float64Array.from({ length: n }, (_, i) => Math.pow(10, a + (b - a) * i / (n - 1))); })();
/** How far to pull the preamp down so boosts don't distort (see applyAudio). */
function headroomDb(s) {
  if (!s.autoHeadroom) return 0;
  const peak = Math.max(0, ...compositeDb(s, LOG_GRID, 48000));
  return Math.min(9, peak) * 0.65;   // partial on purpose — the limiter catches the rest, and this keeps boosted music from sounding "quiet"
}

/* ---------------------------------------------------------------------
   Engine — the shared audio graph
   --------------------------------------------------------------------- */
const E = { media: null, lazy: false, g: null, failed: false, armed: false, wetConnected: false, wetTimer: null, reverbOn: false, irCache: {}, nodeMode: false, extCtx: null, extInput: null, extOutput: null, isPlayingFn: null };
let st = defaultState();
const listeners = [];
function notify() { const snap = api.snapshot(); listeners.forEach(fn => { try { fn(snap); } catch (e) { /* a UI listener must never break audio */ } }); }
/** Is there audio actually flowing right now? A single <media> element
 *  answers this itself (.paused); DJ mode's dual-deck mix has no one
 *  element to ask, so it hands us a callback instead (see attachToNode). */
function sourcePlaying() {
  if (E.media) return !E.media.paused;
  if (E.isPlayingFn) return !!E.isPlayingFn();
  return false;
}

function makeImpulse(ctx, key) {
  const cfg = REVERB_SIZES[key] || REVERB_SIZES.hall;
  const rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * cfg.seconds)), pre = Math.floor(rate * 0.012);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch); let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      const a = 0.35 + 0.55 * t;                     // one-pole low-pass that closes over time → tail gets darker, like a real room
      lp = lp * a + (Math.random() * 2 - 1) * (1 - a);
      d[i] = lp * Math.pow(1 - t, cfg.decay) * 2.4;
    }
  }
  return buf;
}

function buildAudioGraph(ctx, srcNode, destNode) {
  const G = () => ctx.createGain();

  // Force a clean stereo image (mono → dual-mono, 5.1 → stereo) once, up front.
  const inTrim = G(); inTrim.channelCount = 2; inTrim.channelCountMode = "explicit"; inTrim.channelInterpretation = "speakers";
  const dry = G(), wet = G(), master = G(), pre = G();
  srcNode.connect(inTrim); inTrim.connect(dry); dry.connect(master);
  wet.gain.value = 0;
  wet.connect(pre);

  const mk = (type, f, q) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; n.gain.value = 0; return n; };
  const tone = TONE_FILTERS.map(t => mk(t.type, t.f, t.q));
  const bands = FREQS.map((f, i) => mk(BAND_TYPES[i], f, BAND_Q));
  const chain = [pre].concat(tone, bands);
  for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);

  // Mid/side stereo width + per-channel balance (no StereoPanner needed → works on older Safari too)
  const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  const midL = G(), midR = G(), sideL = G(), sideR = G(), mid = G(), side = G(), sideInv = G(), sumL = G(), sumR = G(), balL = G(), balR = G();
  midL.gain.value = 0.5; midR.gain.value = 0.5; sideL.gain.value = 0.5; sideR.gain.value = -0.5; sideInv.gain.value = -1;
  chain[chain.length - 1].connect(split);
  split.connect(midL, 0); split.connect(sideL, 0); split.connect(midR, 1); split.connect(sideR, 1);
  midL.connect(mid); midR.connect(mid); sideL.connect(side); sideR.connect(side);
  mid.connect(sumL); side.connect(sumL);                 // L = mid + side·w
  mid.connect(sumR); side.connect(sideInv); sideInv.connect(sumR); // R = mid − side·w
  sumL.connect(balL); sumR.connect(balR);
  balL.connect(merge, 0, 0); balR.connect(merge, 0, 1);

  // Reverb (parallel send, only wired while the mix is above zero) → leveler → limiter
  const stageOut = G(), levIn = G(), send = G(), conv = ctx.createConvolver(), reverbRet = G();
  merge.connect(stageOut); stageOut.connect(levIn);
  send.connect(conv); conv.connect(reverbRet); reverbRet.connect(levIn);
  const comp = ctx.createDynamicsCompressor(), makeup = G(), limiter = ctx.createDynamicsCompressor(), wetOut = G();
  levIn.connect(comp); comp.connect(makeup); makeup.connect(limiter); limiter.connect(wetOut); wetOut.connect(master);
  limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.1;

  // Analysers: a small/fast one for beat detection (same settings Rage Mode always used) and a fine one for the EQ display
  const beat = ctx.createAnalyser(); beat.fftSize = 256; beat.smoothingTimeConstant = 0.75;
  const spectrum = ctx.createAnalyser(); spectrum.fftSize = 4096; spectrum.smoothingTimeConstant = 0.82;
  master.connect(destNode); master.connect(beat); master.connect(spectrum);

  return { ctx, src: srcNode, inTrim, dry, wet, pre, tone, bands, midSide: { side }, balL, balR, stageOut, send, conv, reverbRet, comp, makeup, master, beat, spectrum };
}

/** A single <media> element source — the music/video player's normal case.
 *  Owns its own AudioContext, since it's the only thing on the page that
 *  needs one. */
function buildGraph(media) {
  const AC = global.AudioContext || global.webkitAudioContext;
  if (!AC) throw new Error("Web Audio not supported");
  let ctx; try { ctx = new AC({ latencyHint: "playback" }); } catch (e) { ctx = new AC(); }
  const src = ctx.createMediaElementSource(media);
  const g = buildAudioGraph(ctx, src, ctx.destination);

  // Autoplay/backgrounding can leave the context suspended — and a suspended
  // context means SILENCE once the element is routed through it. Keep it awake.
  const wake = () => { if (ctx.state === "suspended" || ctx.state === "interrupted") ctx.resume().catch(() => {}); };
  media.addEventListener("play", wake);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !media.paused) wake(); });
  document.addEventListener("pointerdown", wake, { passive: true });
  ctx.onstatechange = () => { if (!media.paused) wake(); };
  wake();
  return g;
}

/** An existing node in a graph the page already built (DJ mode's two decks
 *  summed into one gain node ahead of the speakers) — the EQ is inserted
 *  between srcNode and destNode rather than owning the AudioContext or
 *  tapping a <media> element itself. */
function buildGraphFromNode(ctx, srcNode, destNode) {
  const g = buildAudioGraph(ctx, srcNode, destNode);
  const wake = () => { if (ctx.state === "suspended" || ctx.state === "interrupted") ctx.resume().catch(() => {}); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  document.addEventListener("pointerdown", wake, { passive: true });
  wake();
  return g;
}

/** Build (once) and return the shared graph, or null if this browser can't. */
function ensureGraph(media) {
  if (E.g) { const c = E.g.ctx; if (c.state === "suspended" || c.state === "interrupted") c.resume().catch(() => {}); return E.g; }
  if (E.failed) return null;
  if (E.nodeMode) {
    try { E.g = buildGraphFromNode(E.extCtx, E.extInput, E.extOutput); } catch (err) {
      console.warn("Equalizer: couldn't build the audio graph — playback continues untouched.", err);
      E.failed = true; return null;
    }
    applyAudio();
    return E.g;
  }
  media = media || E.media;
  if (!media) return null;
  try { E.g = buildGraph(media); } catch (err) {
    console.warn("Equalizer: couldn't build the audio graph — playback continues untouched.", err);
    E.failed = true; return null;
  }
  applyAudio();
  return E.g;
}

function setActive(g, on) {
  const t = g.ctx.currentTime, tc = 0.012;
  g.wet.gain.setTargetAtTime(on ? 1 : 0, t, tc);
  g.dry.gain.setTargetAtTime(on ? 0 : 1, t, tc);
  clearTimeout(E.wetTimer);
  if (on) {
    if (!E.wetConnected) { g.inTrim.connect(g.wet); E.wetConnected = true; }
  } else if (E.wetConnected) {
    // let the crossfade finish, then stop paying CPU for the idle chain
    E.wetTimer = setTimeout(() => { try { g.inTrim.disconnect(g.wet); } catch (e) {} E.wetConnected = false; }, 120);
  }
}

function applyAudio() {
  const g = E.g; if (!g) return;
  const t = g.ctx.currentTime, tc = 0.03;
  const active = st.enabled && !isNeutral(st);
  setActive(g, active);
  st.bands.forEach((v, i) => g.bands[i].gain.setTargetAtTime(v, t, tc));
  TONE_FILTERS.forEach((tf, i) => g.tone[i].gain.setTargetAtTime(st.tone[tf.key], t, tc));
  g.pre.gain.setTargetAtTime(Math.pow(10, (st.preamp - headroomDb(st)) / 20), t, tc);
  g.midSide.side.gain.setTargetAtTime(st.width / 100, t, tc);
  const b = st.balance / 100;
  g.balL.gain.setTargetAtTime(b > 0 ? 1 - b : 1, t, tc);
  g.balR.gain.setTargetAtTime(b < 0 ? 1 + b : 1, t, tc);

  // reverb
  const mix = st.reverb / 100;
  if (mix > 0.004) {
    if (E.irKey !== st.reverbSize) { E.irKey = st.reverbSize; g.conv.buffer = E.irCache[st.reverbSize] || (E.irCache[st.reverbSize] = makeImpulse(g.ctx, st.reverbSize)); }
    if (!E.reverbOn) { try { g.stageOut.connect(g.send); } catch (e) {} E.reverbOn = true; }
    g.send.gain.setTargetAtTime(1, t, tc);
    g.reverbRet.gain.setTargetAtTime(mix * 0.7, t, tc);
  } else if (E.reverbOn) {
    g.reverbRet.gain.setTargetAtTime(0, t, tc);
    clearTimeout(E.revTimer);
    E.revTimer = setTimeout(() => { if (st.reverb / 100 <= 0.004) { try { g.stageOut.disconnect(g.send); } catch (e) {} E.reverbOn = false; } }, 600);
  }

  // night leveler: 0 = transparent, 100 = strongly evened out (with makeup gain so it doesn't just get quieter)
  const a = st.leveler / 100;
  g.comp.threshold.setTargetAtTime(-6 - a * 34, t, tc);
  g.comp.ratio.setTargetAtTime(1 + a * 11, t, tc);
  g.comp.knee.setTargetAtTime(24, t, tc);
  g.comp.attack.setTargetAtTime(0.012, t, tc);
  g.comp.release.setTargetAtTime(0.28, t, tc);
  g.makeup.gain.setTargetAtTime(Math.pow(10, (a * 8) / 20), t, tc);
}

/* ---------------------------------------------------------------------
   Persistence
   --------------------------------------------------------------------- */
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { global.VV.idbSet("kv", "eq", st).catch(() => {}); } catch (e) {} }, 400);
}
function commit(opts) {
  opts = opts || {};
  applyAudio();
  if (E.lazy && !E.g && st.enabled && !isNeutral(st) && opts.gesture) ensureGraph();
  persist(); notify();
  if (UI.root) uiSync();
}
function isEngaged() { return st.enabled && !isNeutral(st); }

/* ---------------------------------------------------------------------
   State mutators (all UI goes through these)
   --------------------------------------------------------------------- */
function markCustom() { if (st.preset !== "custom") st.preset = "custom"; }
const api = {
  presets: PRESETS,
  get state() { return st; },
  snapshot() { return { enabled: st.enabled, engaged: isEngaged(), preset: st.preset, neutral: isNeutral(st) }; },
  subscribe(fn) { listeners.push(fn); try { fn(api.snapshot()); } catch (e) {} },
  isOpen() { return !!(UI.root && UI.root.classList.contains("open")); },

  /** Wire this page's media element. lazy = don't touch the element until the EQ is actually used (video page). */
  attach(media, opts) {
    E.media = media; E.lazy = !!(opts && opts.lazy);
    if (opts && opts.toast) E.toast = opts.toast;
    return api.load();
  },
  /** Wire an existing Web Audio node graph instead of a single <media>
   *  element — for pages that already own an AudioContext (DJ mode's two
   *  decks summed into one gain node ahead of the speakers). The EQ chain
   *  is inserted between inputNode and outputTarget.
   *  opts.isPlaying: () => bool — since there's no one element to check
   *  .paused on, this drives the live-spectrum display instead. */
  attachToNode(ctx, inputNode, outputTarget, opts) {
    E.nodeMode = true; E.extCtx = ctx; E.extInput = inputNode; E.extOutput = outputTarget;
    E.lazy = !!(opts && opts.lazy);
    E.isPlayingFn = (opts && opts.isPlaying) || null;
    if (opts && opts.toast) E.toast = opts.toast;
    return api.load();
  },
  async load() {
    try { const raw = await global.VV.idbGet("kv", "eq"); st = sanitize(raw); } catch (e) { st = defaultState(); }
    applyAudio(); notify(); if (UI.root) uiSync();
    // A saved non-flat sound on a lazy page can only be wired up from a real user gesture (autoplay rules) → arm one-shot listeners.
    if (E.lazy && isEngaged() && !E.g && !E.armed) {
      E.armed = true;
      const go = () => { ["pointerdown", "keydown", "touchend"].forEach(ev => document.removeEventListener(ev, go, true)); ensureGraph(); };
      ["pointerdown", "keydown", "touchend"].forEach(ev => document.addEventListener(ev, go, true));
    }
  },
  ensureGraph,
  /** 0‥1 bass energy from the shared beat analyser (Rage Mode + lyrics glow). */
  beat() {
    const g = E.g; if (!g) return 0;
    if (!E._beatBuf) E._beatBuf = new Uint8Array(g.beat.frequencyBinCount);
    g.beat.getByteFrequencyData(E._beatBuf);
    let s = 0; for (let i = 0; i < 5; i++) s += E._beatBuf[i];
    return s / 5 / 255;
  },

  setBand(i, db, opts) { st.bands[i] = clamp(Math.round(db * 2) / 2, -BAND_RANGE, BAND_RANGE); markCustom(); commit({ gesture: true }); },
  setPreamp(db) { st.preamp = clamp(Math.round(db * 2) / 2, -12, 12); markCustom(); commit({ gesture: true }); },
  setTone(key, db) { st.tone[key] = clamp(Math.round(db * 2) / 2, -TONE_RANGE, TONE_RANGE); markCustom(); commit({ gesture: true }); },
  setWidth(p) { st.width = clamp(Math.round(p / 5) * 5, 0, 200); markCustom(); commit({ gesture: true }); },
  setBalance(p) { st.balance = clamp(Math.round(p / 5) * 5, -100, 100); commit({ gesture: true }); },
  setReverb(p) { st.reverb = clamp(Math.round(p / 2) * 2, 0, 100); markCustom(); commit({ gesture: true }); },
  setReverbSize(k) { if (REVERB_SIZES[k]) { st.reverbSize = k; markCustom(); commit({ gesture: true }); } },
  setLeveler(p) { st.leveler = clamp(Math.round(p / 5) * 5, 0, 100); markCustom(); commit({ gesture: true }); },
  setAutoHeadroom(on) { st.autoHeadroom = !!on; commit({ gesture: true }); },
  setEnabled(on) { st.enabled = !!on; commit({ gesture: true }); },
  toggleEnabled() { api.setEnabled(!st.enabled); return st.enabled; },

  applyPreset(id) {
    let sound, name;
    if (PRESET_BY_ID.has(id)) { sound = presetSound(PRESET_BY_ID.get(id)); name = PRESET_BY_ID.get(id).name; }
    else { const c = st.custom.find(x => x.id === id); if (!c) return; sound = sanitizeSound(c.sound); name = c.name; }
    SOUND_KEYS.forEach(k => { st[k] = cloneState({ x: sound[k] }).x; });
    st.preset = id; st.enabled = true;
    commit({ gesture: true });
    return name;
  },
  /** Back to factory: flat, no effects, centered, EQ on. Custom presets are kept. Returns an undo snapshot. */
  reset() {
    const before = cloneState(st);
    const d = defaultState(); d.custom = st.custom;
    st = d;
    commit({ gesture: true });
    return before;
  },
  restore(snapshot) { st = sanitize(snapshot); commit({ gesture: true }); },
  saveCustom(name) {
    name = String(name || "").trim().slice(0, 24);
    if (!name) return null;
    if (st.custom.length >= 12) return null;
    const sound = {}; SOUND_KEYS.forEach(k => { sound[k] = cloneState({ x: st[k] }).x; });
    const c = { id: "u" + Date.now().toString(36), name, sound };
    st.custom.push(c); st.preset = c.id;
    commit({ gesture: true });
    return c;
  },
  deleteCustom(id) {
    const before = cloneState(st);
    st.custom = st.custom.filter(c => c.id !== id);
    if (st.preset === id) st.preset = "custom";
    commit({ gesture: true });
    return before;
  },

  // exposed for tests / other modules
  _math: { biquadCoeffs, biquadDb, compositeDb, headroomDb, isNeutral, sanitize, defaultState, presetSound, FREQS, LOG_GRID },
};

/* =========================================================================
   UI — built lazily on first open, appended to <body>
   ========================================================================= */
const UI = { root: null, view: FREQS.map(() => 0), raf: 0, tab: "bands", drag: -1, opener: null, undoTimer: null, undoFn: null, spec: null, colors: {} };

const LAB = [
  { group: "Tone", note: "Quick, gentle shaping — works on top of the 10 bands." },
  { key: "bass",   label: "Bass",   min: -TONE_RANGE, max: TONE_RANGE, step: 0.5, def: 0, get: () => st.tone.bass,   set: v => api.setTone("bass", v),   fmt: v => sgn(v) + " dB" },
  { key: "mid",    label: "Mid / Voice", min: -TONE_RANGE, max: TONE_RANGE, step: 0.5, def: 0, get: () => st.tone.mid,    set: v => api.setTone("mid", v),    fmt: v => sgn(v) + " dB" },
  { key: "treble", label: "Treble", min: -TONE_RANGE, max: TONE_RANGE, step: 0.5, def: 0, get: () => st.tone.treble, set: v => api.setTone("treble", v), fmt: v => sgn(v) + " dB" },
  { group: "Stereo", note: "Width 0% is true mono — handy with a single earbud. Balance fixes a weaker ear." },
  { key: "width",   label: "Stereo width", min: 0, max: 200, step: 5, def: 100, get: () => st.width, set: v => api.setWidth(v), fmt: v => v === 0 ? "Mono" : v === 100 ? "Natural" : v + "%" },
  { key: "balance", label: "Balance", min: -100, max: 100, step: 5, def: 0, get: () => st.balance, set: v => api.setBalance(v), fmt: v => v === 0 ? "Center" : (v < 0 ? "Left " + (-v) : "Right " + v) },
  { group: "Space & Dynamics", note: "Night Leveler evens out loud and quiet parts — great late at night or for movies and podcasts." },
  { key: "reverb",  label: "Space (reverb)", min: 0, max: 100, step: 2, def: 0, get: () => st.reverb, set: v => api.setReverb(v), fmt: v => v === 0 ? "Off" : v + "%" },
  { custom: "reverbSize" },
  { key: "leveler", label: "Night Leveler", min: 0, max: 100, step: 5, def: 0, get: () => st.leveler, set: v => api.setLeveler(v), fmt: v => v === 0 ? "Off" : v + "%" },
];
function sgn(v) { return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1).replace(/\.0$/, ""); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function buildUI() {
  const root = document.createElement("div");
  root.className = "vq-overlay"; root.id = "vqOverlay";
  root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-label", "Equalizer");
  root.innerHTML = `
  <div class="vq-panel">
    <div class="vq-head">
      <div class="vq-titlewrap"><div class="vq-title">Equalizer</div><div class="vq-status" id="vqStatus" aria-live="polite"></div></div>
      <button class="vq-power" id="vqPower" role="switch" aria-checked="true" title="EQ on / off — compare with the original sound">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v9M6.4 6.6a8 8 0 1011.2 0"/></svg><span>On</span>
      </button>
      <button class="vq-reset" id="vqReset" title="Reset everything to default">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span>Reset</span>
      </button>
      <button class="vq-close" id="vqClose" aria-label="Close equalizer">✕</button>
    </div>

    <div class="vq-presets" id="vqPresets" role="group" aria-label="Presets"></div>
    <div class="vq-saverow hidden" id="vqSaveRow">
      <input type="text" id="vqSaveName" maxlength="24" placeholder="Name your sound…" aria-label="Preset name">
      <button class="vq-mini primary" id="vqSaveOk">Save</button><button class="vq-mini" id="vqSaveCancel">Cancel</button>
    </div>

    <div class="vq-viz"><canvas id="vqCanvas" aria-label="Frequency response. Drag a dot to change a band."></canvas><div class="vq-viz-hint" id="vqHint">Drag the dots — or use the sliders below</div></div>

    <div class="vq-tabs" role="tablist">
      <button role="tab" class="active" data-tab="bands" aria-selected="true">🎚 10 Bands</button>
      <button role="tab" data-tab="lab" aria-selected="false">🎛 Sound Lab</button>
    </div>

    <div class="vq-pane" data-pane="bands">
      <div class="vq-bands" id="vqBands"></div>
      <div class="vq-preamp">
        <label for="vqPreamp">Preamp</label>
        <input type="range" class="vq-range" id="vqPreamp" min="-12" max="12" step="0.5" value="0">
        <span class="vq-val" id="vqPreampVal">0 dB</span>
      </div>
      <div class="vq-headroom">
        <div class="vq-headroom-text"><b>Auto headroom</b><span id="vqHeadNote">Lowers the level a little when you boost, so loud music doesn't distort.</span></div>
        <button class="switch on" id="vqHeadSwitch" role="switch" aria-checked="true" aria-label="Auto headroom"></button>
      </div>
    </div>

    <div class="vq-pane hidden" data-pane="lab" id="vqLab"></div>

    <div class="vq-undo hidden" id="vqUndo"><span id="vqUndoText"></span><button id="vqUndoBtn">Undo</button></div>
  </div>`;
  document.body.appendChild(root);
  UI.root = root;
  const $ = (s) => root.querySelector(s);
  UI.el = { status: $("#vqStatus"), power: $("#vqPower"), presets: $("#vqPresets"), saveRow: $("#vqSaveRow"), saveName: $("#vqSaveName"),
    canvas: $("#vqCanvas"), bands: $("#vqBands"), preamp: $("#vqPreamp"), preampVal: $("#vqPreampVal"), headSwitch: $("#vqHeadSwitch"),
    headNote: $("#vqHeadNote"), lab: $("#vqLab"), undo: $("#vqUndo"), undoText: $("#vqUndoText"), hint: $("#vqHint") };

  // ---- 10 band sliders (custom, keyboard-accessible) ----
  UI.el.bands.innerHTML = FREQS.map((f, i) => `
    <div class="vq-band" data-i="${i}">
      <div class="vq-band-val" id="vqBv${i}">0</div>
      <div class="vq-track" data-i="${i}" role="slider" tabindex="0" aria-orientation="vertical" aria-label="${FREQ_LABEL(f)} hertz"
           aria-valuemin="${-BAND_RANGE}" aria-valuemax="${BAND_RANGE}" aria-valuenow="0" aria-valuetext="0 decibels">
        <div class="vq-zero"></div><div class="vq-fill"></div><div class="vq-thumb"></div>
      </div>
      <div class="vq-band-f">${FREQ_LABEL(f)}</div>
    </div>`).join("");
  UI.el.bands.querySelectorAll(".vq-track").forEach(bindBandSlider);

  // ---- Sound Lab ----
  UI.el.lab.innerHTML = LAB.map((c, idx) => {
    if (c.group) return `<div class="vq-group"><div class="vq-group-t">${c.group}</div><div class="vq-group-n">${c.note}</div></div>`;
    if (c.custom === "reverbSize") return `<div class="vq-sizes" id="vqSizes" role="group" aria-label="Room size">${Object.keys(REVERB_SIZES).map(k => `<button data-size="${k}">${REVERB_SIZES[k].label}</button>`).join("")}</div>`;
    return `<div class="vq-ctl"><div class="vq-ctl-top"><label for="vqL${idx}">${c.label}</label><span class="vq-val" id="vqLv${idx}"></span></div>
      <input type="range" class="vq-range" id="vqL${idx}" data-idx="${idx}" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.def}"></div>`;
  }).join("");
  UI.el.lab.querySelectorAll("input.vq-range").forEach(inp => {
    const c = LAB[Number(inp.dataset.idx)];
    inp.addEventListener("input", () => c.set(Number(inp.value)));
    inp.addEventListener("dblclick", () => c.set(c.def));
  });
  UI.el.lab.querySelectorAll("#vqSizes button").forEach(b => b.addEventListener("click", () => api.setReverbSize(b.dataset.size)));

  // ---- header controls ----
  $("#vqClose").addEventListener("click", close);
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
  UI.el.power.addEventListener("click", () => api.toggleEnabled());
  $("#vqReset").addEventListener("click", doReset);
  $("#vqUndoBtn").addEventListener("click", () => { const fn = UI.undoFn; hideUndo(); if (fn) fn(); });
  UI.el.headSwitch.addEventListener("click", () => api.setAutoHeadroom(!st.autoHeadroom));
  UI.el.preamp.addEventListener("input", () => api.setPreamp(Number(UI.el.preamp.value)));
  UI.el.preamp.addEventListener("dblclick", () => api.setPreamp(0));
  root.querySelectorAll(".vq-tabs button").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("#vqSaveOk").addEventListener("click", doSave);
  $("#vqSaveCancel").addEventListener("click", () => UI.el.saveRow.classList.add("hidden"));
  UI.el.saveName.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
  bindCanvas();
  window.addEventListener("resize", () => { if (api.isOpen()) sizeCanvas(); });
  // Escape closes the EQ before anything underneath (player, lyrics…) reacts —
  // captured at the window level so it always wins regardless of what has
  // focus. One layer first: if the "save a custom preset" row is open,
  // Escape backs out of just that (keeping the panel itself open), same as
  // it would for any other in-panel popover — only a second Escape (or one
  // pressed while the row isn't open) closes the whole panel.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && api.isOpen()) {
      e.stopImmediatePropagation(); e.preventDefault();
      if (!UI.el.saveRow.classList.contains("hidden")) { UI.el.saveRow.classList.add("hidden"); UI.el.saveName.blur(); return; }
      close();
    }
    else if (e.key === "Tab" && api.isOpen()) trapFocus(e);
  }, true);
}

function trapFocus(e) {
  const f = Array.from(UI.root.querySelectorAll("button:not(.hidden):not([disabled]), input:not([disabled]), [tabindex='0']")).filter(n => n.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!UI.root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
}

function setTab(tab) {
  UI.tab = tab;
  UI.root.querySelectorAll(".vq-tabs button").forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
  UI.root.querySelectorAll(".vq-pane").forEach(p => p.classList.toggle("hidden", p.dataset.pane !== tab));
  uiSync();
}

/* ---- band slider interaction ---- */
function dbFromPointer(track, clientY) {
  const r = track.getBoundingClientRect();
  const pad = 9;                                    // thumb radius so the extremes are reachable
  const t = clamp((clientY - r.top - pad) / Math.max(1, r.height - pad * 2), 0, 1);
  let db = BAND_RANGE - t * BAND_RANGE * 2;
  if (Math.abs(db) < 0.6) db = 0;                   // magnet to 0 dB
  return db;
}
function bindBandSlider(track) {
  const i = Number(track.dataset.i);
  let active = false;
  track.addEventListener("pointerdown", (e) => { active = true; track.setPointerCapture(e.pointerId); api.setBand(i, dbFromPointer(track, e.clientY)); e.preventDefault(); });
  track.addEventListener("pointermove", (e) => { if (active) api.setBand(i, dbFromPointer(track, e.clientY)); });
  const end = (e) => { active = false; try { track.releasePointerCapture(e.pointerId); } catch (err) {} };
  track.addEventListener("pointerup", end); track.addEventListener("pointercancel", end);
  track.addEventListener("dblclick", () => api.setBand(i, 0));
  track.addEventListener("keydown", (e) => {
    const cur = st.bands[i]; let nv = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") nv = cur + (e.shiftKey ? 3 : 0.5);
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") nv = cur - (e.shiftKey ? 3 : 0.5);
    else if (e.key === "PageUp") nv = cur + 3; else if (e.key === "PageDown") nv = cur - 3;
    else if (e.key === "Home") nv = BAND_RANGE; else if (e.key === "End") nv = -BAND_RANGE;
    else if (e.key === "0" || e.key === "Backspace" || e.key === "Delete") nv = 0;
    if (nv === null) return;
    e.preventDefault(); e.stopPropagation();        // keep the player's own arrow-key shortcuts (seek) out of this
    api.setBand(i, nv);
  });
}

/* ---- canvas: response curve + live spectrum + draggable dots ---- */
const xOfF = (f, w) => (Math.log10(f) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20)) * w;
const fOfX = (x, w) => Math.pow(10, Math.log10(20) + (x / w) * (Math.log10(20000) - Math.log10(20)));
const yOfDb = (db, h) => h / 2 - clamp(db, -VIEW_DB, VIEW_DB) / VIEW_DB * (h / 2 - 6);
const dbOfY = (y, h) => (h / 2 - y) / (h / 2 - 6) * VIEW_DB;

function sizeCanvas() {
  const c = UI.el.canvas, dpr = Math.min(2, global.devicePixelRatio || 1);
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return false;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  UI.dpr = dpr; UI.cw = w; UI.ch = h;
  return true;
}
/** "#RRGGBB" + 2-hex alpha → "#RRGGBBAA"; anything else is returned as-is (still valid, just opaque). */
const A = (c, a) => (/^#[0-9a-f]{6}$/i.test(c) ? c + a : c);
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n, d) => (cs.getPropertyValue(n).trim() || d);
  UI.colors = { accent: g("--accent", "#C9A84C"), accent2: g("--accent2", "#B22222"), muted: g("--text-muted", "#777"), divider: g("--divider", "#222"), text: g("--text-secondary", "#bbb") };
}
function bindCanvas() {
  const c = UI.el.canvas;
  const pick = (e) => {
    const r = c.getBoundingClientRect(), x = e.clientX - r.left;
    let best = -1, bd = 26;
    FREQS.forEach((f, i) => { const d = Math.abs(xOfF(f, r.width) - x); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  c.addEventListener("pointerdown", (e) => {
    const i = pick(e); if (i < 0) return;
    UI.drag = i; c.setPointerCapture(e.pointerId); e.preventDefault();
    const r = c.getBoundingClientRect(); api.setBand(i, dbOfY(e.clientY - r.top, r.height));
  });
  c.addEventListener("pointermove", (e) => {
    const r = c.getBoundingClientRect();
    if (UI.drag >= 0) { let db = dbOfY(e.clientY - r.top, r.height); if (Math.abs(db) < 0.6) db = 0; api.setBand(UI.drag, db); }
    else c.classList.toggle("vv-cursor-grab", pick(e) >= 0);
  });
  const end = (e) => { UI.drag = -1; try { c.releasePointerCapture(e.pointerId); } catch (err) {} };
  c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
  c.addEventListener("dblclick", (e) => { const i = pick(e); if (i >= 0) api.setBand(i, 0); });
}

function drawFrame() {
  if (!sizeCanvas()) return;
  const c = UI.el.canvas, x = c.getContext("2d"), w = UI.cw, h = UI.ch, col = UI.colors;
  x.setTransform(UI.dpr, 0, 0, UI.dpr, 0, 0);
  x.clearRect(0, 0, w, h);

  // grid
  x.lineWidth = 1; x.font = "10px " + (getComputedStyle(document.body).fontFamily || "monospace"); x.textBaseline = "top";
  [-12, -6, 0, 6, 12].forEach(db => {
    const y = yOfDb(db, h);
    x.strokeStyle = db === 0 ? col.muted : col.divider; x.globalAlpha = db === 0 ? 0.55 : 0.6;
    x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke();
    x.globalAlpha = 0.75; x.fillStyle = col.muted; if (db !== 0) x.fillText((db > 0 ? "+" : "−") + Math.abs(db), 4, y + 2);
  });
  x.globalAlpha = 0.5; x.strokeStyle = col.divider;
  FREQS.forEach(f => { const px = Math.round(xOfF(f, w)) + 0.5; x.beginPath(); x.moveTo(px, 0); x.lineTo(px, h); x.stroke(); });
  x.globalAlpha = 0.8; x.fillStyle = col.muted; x.textBaseline = "bottom";
  [100, 1000, 10000].forEach(f => x.fillText(f >= 1000 ? (f / 1000) + "k" : f, xOfF(f, w) + 3, h - 2));
  x.globalAlpha = 1;

  // live spectrum (post-EQ, i.e. what you hear)
  const g = E.g, playing = g && sourcePlaying() && g.ctx.state === "running";
  if (!UI.spec || !g) UI.spec = new Float32Array(160);
  if (g) {
    if (!UI.specBuf) UI.specBuf = new Uint8Array(g.spectrum.frequencyBinCount);
    if (playing) g.spectrum.getByteFrequencyData(UI.specBuf);
    const nyq = g.ctx.sampleRate / 2, n = UI.specBuf.length;
    for (let i = 0; i < UI.spec.length; i++) {
      const f = LOG_GRID[i], pos = f / nyq * n, i0 = Math.floor(pos), fr = pos - i0;
      const target = playing ? ((UI.specBuf[i0] || 0) * (1 - fr) + (UI.specBuf[Math.min(n - 1, i0 + 1)] || 0) * fr) / 255 : 0;
      UI.spec[i] += (target - UI.spec[i]) * (target > UI.spec[i] ? 0.5 : 0.12);
    }
  }
  const sg = x.createLinearGradient(0, h, 0, 0); sg.addColorStop(0, A(col.accent, "00")); sg.addColorStop(1, A(col.accent, "66"));
  x.beginPath(); x.moveTo(0, h);
  for (let i = 0; i < UI.spec.length; i++) x.lineTo(xOfF(LOG_GRID[i], w), h - Math.pow(UI.spec[i], 1.3) * h * 0.85);
  x.lineTo(w, h); x.closePath(); x.fillStyle = sg; x.fill();

  // combined response curve, computed from the live (animated) view values
  const view = { bands: UI.view, tone: st.tone };
  const db = compositeDb(view, LOG_GRID, (g && g.ctx.sampleRate) || 48000);
  const y0 = yOfDb(0, h);
  x.beginPath(); x.moveTo(0, y0);
  for (let i = 0; i < db.length; i++) x.lineTo(xOfF(LOG_GRID[i], w), yOfDb(db[i], h));
  x.lineTo(w, y0); x.closePath();
  const fillG = x.createLinearGradient(0, 0, 0, h); fillG.addColorStop(0, A(col.accent, "55")); fillG.addColorStop(0.5, A(col.accent, "10")); fillG.addColorStop(1, A(col.accent2, "55"));
  x.fillStyle = fillG; x.globalAlpha = st.enabled ? 1 : 0.3; x.fill();
  x.beginPath();
  for (let i = 0; i < db.length; i++) { const px = xOfF(LOG_GRID[i], w), py = yOfDb(db[i], h); if (i) x.lineTo(px, py); else x.moveTo(px, py); }
  x.strokeStyle = st.enabled ? col.accent : col.muted; x.lineWidth = 2.2; x.shadowColor = col.accent; x.shadowBlur = st.enabled ? 10 : 0; x.stroke(); x.shadowBlur = 0;
  x.globalAlpha = 1;

  // handles
  FREQS.forEach((f, i) => {
    const px = xOfF(f, w), py = yOfDb(UI.view[i], h), on = UI.drag === i;
    x.beginPath(); x.arc(px, py, on ? 8 : 5.5, 0, Math.PI * 2);
    x.fillStyle = on ? col.accent : "#0b0b0b"; x.fill(); x.lineWidth = 2; x.strokeStyle = st.enabled ? col.accent : col.muted; x.stroke();
  });
}

function loop() {
  if (!api.isOpen()) { UI.raf = 0; return; }
  const reduce = global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let moved = false;
  for (let i = 0; i < FREQS.length; i++) {
    const d = st.bands[i] - UI.view[i];
    if (Math.abs(d) < 0.02) { if (UI.view[i] !== st.bands[i]) { UI.view[i] = st.bands[i]; moved = true; } }
    else { UI.view[i] = reduce ? st.bands[i] : UI.view[i] + d * 0.3; moved = true; }
  }
  if (moved) paintBands();
  drawFrame();
  UI.raf = requestAnimationFrame(loop);
}

/* ---- DOM sync ---- */
function paintBands() {
  FREQS.forEach((f, i) => {
    const v = UI.view[i], band = UI.el.bands.children[i]; if (!band) return;
    const fr = (BAND_RANGE - v) / (BAND_RANGE * 2);          // 0 = top (+12), 1 = bottom (−12)
    const track = band.querySelector(".vq-track");
    track.style.setProperty("--pos", fr.toFixed(4));
    track.style.setProperty("--fill-top", Math.min(fr, 0.5).toFixed(4));
    track.style.setProperty("--fill-h", Math.abs(fr - 0.5).toFixed(4));
    track.classList.toggle("cut", v < 0);
    const shown = st.bands[i];
    band.querySelector(".vq-band-val").textContent = sgn(shown);
    track.setAttribute("aria-valuenow", String(shown)); track.setAttribute("aria-valuetext", sgn(shown) + " decibels");
  });
}
function presetName() {
  if (PRESET_BY_ID.has(st.preset)) return PRESET_BY_ID.get(st.preset).name;
  const c = st.custom.find(x => x.id === st.preset); return c ? c.name : "Custom";
}
function uiSync() {
  if (!UI.root) return;
  const el = UI.el;
  el.power.setAttribute("aria-checked", String(st.enabled)); el.power.classList.toggle("off", !st.enabled);
  el.power.querySelector("span").textContent = st.enabled ? "On" : "Off";
  UI.root.classList.toggle("is-off", !st.enabled);
  const head = headroomDb(st);
  el.status.textContent = !st.enabled ? "Off — you're hearing the original" : isNeutral(st) ? "Flat — sound untouched" : presetName() + (head > 0.4 ? " · headroom −" + head.toFixed(1) + " dB" : "");
  el.headNote.textContent = st.autoHeadroom && head > 0.4 ? "Currently lowering the level by " + head.toFixed(1) + " dB to keep boosts clean." : "Lowers the level a little when you boost, so loud music doesn't distort.";

  // presets — only re-render the row when it could have changed (not on every slider nudge)
  const sig = st.preset + "|" + st.custom.map(c => c.id + c.name).join(",");
  if (sig !== UI.chipSig) { UI.chipSig = sig; renderChips(); }

  // preamp + headroom
  el.preamp.value = st.preamp; el.preampVal.textContent = sgn(st.preamp) + " dB";
  setRangeFill(el.preamp, -12, 12, st.preamp, true);
  el.headSwitch.classList.toggle("on", st.autoHeadroom); el.headSwitch.setAttribute("aria-checked", String(st.autoHeadroom));

  // sound lab
  LAB.forEach((c, idx) => {
    if (!c.key) return;
    const inp = el.lab.querySelector("#vqL" + idx), val = el.lab.querySelector("#vqLv" + idx); if (!inp) return;
    const v = c.get(); if (document.activeElement !== inp) inp.value = v;
    val.textContent = c.fmt(v);
    setRangeFill(inp, c.min, c.max, v, c.min < 0);
  });
  el.lab.querySelectorAll("#vqSizes button").forEach(b => b.classList.toggle("active", b.dataset.size === st.reverbSize));
  el.lab.querySelector("#vqSizes") && el.lab.querySelector("#vqSizes").classList.toggle("dim", st.reverb === 0);
  paintBands();
}
function renderChips() {
  const el = UI.el;
  const chips = PRESETS.map(p => `<button class="vq-chip${st.preset === p.id ? " active" : ""}" data-p="${p.id}" title="${esc(p.hint)}" aria-pressed="${st.preset === p.id}"><span class="i">${p.icon}</span>${esc(p.name)}</button>`)
    .concat(st.custom.map(c => `<span class="vq-chip-wrap"><button class="vq-chip custom${st.preset === c.id ? " active" : ""}" data-p="${c.id}" aria-pressed="${st.preset === c.id}"><span class="i">★</span>${esc(c.name)}</button><button class="vq-chip-x" data-del="${c.id}" aria-label="Delete ${esc(c.name)}">✕</button></span>`))
    .concat([`<button class="vq-chip add" id="vqAdd" ${st.custom.length >= 12 ? "disabled" : ""}>＋ Save mine</button>`]);
  el.presets.innerHTML = chips.join("");
  el.presets.querySelectorAll(".vq-chip[data-p]").forEach(b => b.addEventListener("click", () => {
    const name = api.applyPreset(b.dataset.p);
    if (name) el.hint.textContent = name + (PRESET_BY_ID.has(b.dataset.p) ? " — " + PRESET_BY_ID.get(b.dataset.p).hint : "");
  }));
  el.presets.querySelectorAll(".vq-chip-x").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const c = st.custom.find(x => x.id === b.dataset.del);
    const before = api.deleteCustom(b.dataset.del);
    showUndo(`Deleted “${c ? c.name : "preset"}”.`, () => api.restore(before));
  }));
  const add = el.presets.querySelector("#vqAdd");
  if (add) add.addEventListener("click", () => { el.saveRow.classList.remove("hidden"); el.saveName.value = ""; el.saveName.focus(); });
  const active = el.presets.querySelector(".vq-chip.active");
  if (active && active.scrollIntoView) { const box = el.presets; const off = active.offsetLeft - box.clientWidth / 2 + active.clientWidth / 2; box.scrollTo ? box.scrollTo({ left: off, behavior: "smooth" }) : (box.scrollLeft = off); }

}
function setRangeFill(inp, min, max, v, bipolar) {
  const p = (v - min) / (max - min) * 100, z = bipolar ? (0 - min) / (max - min) * 100 : 0;
  inp.style.setProperty("--a", Math.min(p, z) + "%"); inp.style.setProperty("--b", Math.max(p, z) + "%");
}

/* ---- actions ---- */
function doReset() {
  const before = api.reset();
  showUndo("Everything is back to default.", () => api.restore(before));
}
function doSave() {
  const name = UI.el.saveName.value.trim();
  if (!name) { UI.el.saveName.focus(); return; }
  const c = api.saveCustom(name);
  if (c) { UI.el.saveRow.classList.add("hidden"); UI.el.hint.textContent = "Saved “" + c.name + "” — it lives under ★ in your presets."; }
}
function showUndo(text, fn) {
  UI.undoFn = fn; UI.el.undoText.textContent = text; UI.el.undo.classList.remove("hidden");
  clearTimeout(UI.undoTimer); UI.undoTimer = setTimeout(hideUndo, 7000);
}
function hideUndo() { clearTimeout(UI.undoTimer); if (UI.el) UI.el.undo.classList.add("hidden"); UI.undoFn = null; }

function open(opener) {
  if (!UI.root) buildUI();
  if (!E.lazy) ensureGraph();          // click = user gesture → context can start running right now
  UI.opener = opener || document.activeElement;
  readColors(); UI.chipSig = null;
  FREQS.forEach((_, i) => { UI.view[i] = st.bands[i]; });
  UI.root.classList.add("open");
  uiSync();
  hideUndo();
  UI.el.hint.textContent = E.g && sourcePlaying() ? "Live spectrum — drag the dots or use the sliders"
    : E.lazy && !E.g ? "Drag the dots — or use the sliders below" : "Play something to see the live spectrum";
  if (!UI.raf) UI.raf = requestAnimationFrame(loop);
  setTimeout(() => { const c = UI.root.querySelector("#vqClose"); c && c.focus(); }, 30);
}
function close() {
  if (!UI.root) return;
  UI.root.classList.remove("open"); hideUndo(); UI.el.saveRow.classList.add("hidden");
  const o = UI.opener; UI.opener = null; if (o && o.focus && document.contains(o)) try { o.focus({ preventScroll: true }); } catch (e) {}
}
api.open = open; api.close = close; api.toggle = (opener) => (api.isOpen() ? close() : open(opener));

global.VaneEQ = api;
})(window);
