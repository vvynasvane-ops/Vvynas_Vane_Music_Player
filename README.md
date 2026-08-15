# Vvynas Vane — Web

A web replica of the Vvynas Vane Android music player: your local song
library, playlists, folders, favorites, monthly/yearly recap, a simple
video player, DJ Mode, and a full-screen player with 42 animated
backgrounds — all running in the browser. No file is ever uploaded;
everything plays straight from the folder you grant access to, on-device.

## Files

```
index.html   Library / player / playlists / folders / favorites (main hub)
video.html   Simple, standard video + M4A player — no animation, no transitions
recap.html   Monthly & yearly listening recap, purple starry theme + poster download
dj.html      DJ Mode — dual decks, crossfader, bass boost, 4 visualizer themes
shared.js    IndexedDB, 8-font manager, storage access, 42 animated themes,
             pixie dust, book-page transition, orbiting globe title, sigil art
app.js       Library page logic
video.js     Video page logic
recap.js     Recap page logic
dj.js        DJ Mode logic + visualizer
style.css    Shared styling
manifest.json / sw.js   PWA install + offline app shell
```

## Running it

Serve over **HTTPS or `localhost`** — a browser requirement for the
storage-access and install features, not something specific to this app.

```bash
cd vvynas-vane-web
python3 -m http.server 8080
# open http://localhost:8080
```

To deploy for real (so "Add to Home Screen" works everywhere), push this
folder to GitHub Pages, Netlify, Vercel, or any static host — no build
step required.

## Features

- **Library**: search + sort by title/artist/album/duration/size/year/date
  added/play count. Folders, Playlists, Favorites, generated per-song gold
  sigil art, shuffle/repeat, up-next queue, full-screen player with
  lock-screen media controls.
- **42 animated backgrounds**, ported theme-by-theme from
  `AnimatedThemeView.java` (same colors, same layout, same motion) —
  select one from Settings → Animated Background. Only shows on the full
  player screen, matching the Android app. Also ported: pixie-dust tap
  sparkles, a storybook page-turn transition on song change, and an
  orbiting globe-title wordmark.
- **8-font customization** (Settings → Font): Monospace (the real app's
  actual default), Serif, Sans-serif, Condensed, Sans-serif Light/Medium/
  Black, and Casual — applied live across the whole app.
- **Monthly & yearly recap** (`recap.html`): a separate purple-starry
  screen (matching `RecapActivity`'s own palette) with listening time,
  songs played, top track, a month-by-month bar chart, and a downloadable
  poster image. Stats accumulate automatically as you listen.
- **Video player** (`video.html`): deliberately plain — standard controls,
  a Video/M4A file list, no animated backdrop or transitions.
- **DJ Mode** (`dj.html`): dual decks with independent play/cue/pitch, a
  real constant-power crossfader, an 808/bass-boost slider, Auto Mix,
  Beat Sync, play-count shoutouts, a battle queue, and 4 beat-reactive
  visualizer themes — ported from `DJModeActivity.java` /
  `DJVisualizer.java`. See below for details.
- **Connecting overlay**: granting or resuming folder access shows a gold
  hourglass loader with cycling status text and a small traveling-car
  progress motif, so it's clear something real is happening in the
  background — rather than a frozen screen.
- **Installable**: manifest + service worker power native "Add to Home
  Screen" on Android/desktop, with in-app instructions for iOS Safari.
  Available anytime from the sidebar or Settings — not pushed on first
  load.
- **Responsive**: sidebar + wide player on tablet/laptop, bottom tab bar +
  compact player on phones.

## Recent fixes

- Removed the "Add to Home Screen" prompt from the first-load onboarding
  screen (still reachable from Settings/sidebar).
- Added the hourglass/orbit/track/dot loaders across the app: hourglass +
  traveling car for the main connecting flow, an orbiting-particle spinner
  while the video page scans a folder and while DJ Mode loads its library,
  and a purple jelly-dot stream while the recap page reads your listening
  history.
- Fixed a mobile tab-bar visibility bug that could leave it in the wrong
  state after a resize/rotation.
- Fixed folder-picker cancellation during a *rescan* incorrectly stranding
  you on the "Grant Access" screen instead of returning to your already-
  loaded library.
- Fixed a bug (present in the video and library pages too) where the
  "Grant Access" button had both a permanent click listener and a
  reassigned `.onclick` for the "Resume Access" state — meaning a resume
  tap fired both at once, popping an unwanted folder picker alongside the
  resume attempt. Every grant button now uses a single reassignable
  handler.

## DJ Mode (`dj.html`)

A full port of `DJModeActivity.java` + `DJVisualizer.java`:

- **Dual decks (A & B)** — independent select/play/cue, each backed by its
  own `<audio>` element routed through the Web Audio API.
- **Real crossfader** — constant-power pan (cos/sin) between decks, the
  same volume math as the Android version.
- **808 / Bass Boost slider** — a Web Audio low-shelf filter standing in
  for Android's `BassBoost` effect, 0–100 mapped to 0–15dB.
- **Pitch sliders** — `playbackRate` 0.5×–1.5×, per deck.
- **Auto Mix** — automatic crossfade + track scheduling when a deck ends,
  with the same phased timing (crossfade → load next → ease back to
  center) as the source.
- **Beat Sync** — a randomized 400–600ms pulse into the visualizer,
  simulating ~100–150 BPM.
- **Play-count shoutouts** — the same Game-of-Thrones-flavored callouts at
  3/5/10/20/50+ plays, plus a manual 🎤 Shout button.
- **DJ Queue** — add tracks, tap to load onto whichever deck is idle, or
  remove with ✕.
- **4 visualizer themes** (DRAGONFIRE / LANNISTER / STARK WINTER / NIGHT
  KING) — a 1:1 canvas port of `DJVisualizer`'s layered grid, laser beams,
  pulsing rings, waveform bars, and particles, all beat- and
  energy-reactive. Cycle with the palette icon.
- **DJ Settings** — visual theme, crossfade duration, bass presets, reset
  play counts, clear queue, and an About panel — matching the Android
  settings sheet.

Reachable from the sidebar, the Settings modal, or directly at `dj.html`.

## Still simplified

The lyrics view and ID3-embedded album art (this still uses generated
sigil art) aren't in this pass — say the word and they can be ported next
the same way, straight from the source.
