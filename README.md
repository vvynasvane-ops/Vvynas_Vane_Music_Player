# Vvynas Vane — Web

A web replica of the Vvynas Vane Android music player: your local song
library, playlists (with rename/sort/multi-select-remove), a default
Recently Played playlist, an editable up-next queue, favorites, folders,
custom RGB accent colors, hazard-themed album art, an opt-in "Rage Mode"
audio-reactive skin, monthly/yearly recap, a video player with
search/subtitles/multi-language audio, DJ Mode, and a full-screen player
with 42 animated backgrounds — all running in the browser. No file is
ever uploaded; everything plays straight from the folder you grant access
to, on-device.

## Files

```
index.html   Library / player / playlists / folders / favorites / recently played
video.html   Video + M4A player — search, subtitles, multi-audio-track support
recap.html   Monthly & yearly listening recap, purple starry theme + poster download
dj.html      DJ Mode — dual decks, crossfader, bass boost, 4 visualizer themes
shared.js    IndexedDB, 8-font manager, storage access, 42 animated themes,
             pixie dust, book-page transition, orbiting globe title, album art
app.js       Library page logic + Rage Mode
video.js     Video page logic
recap.js     Recap page logic
dj.js        DJ Mode logic + visualizer
style.css    Shared styling
manifest.json / sw.js   PWA install + offline app shell
```

## Running it

Serve over **HTTPS or `localhost`** — a browser requirement for the
storage-access and install features.

```bash
cd vvynas-vane-web
python3 -m http.server 8080
# open http://localhost:8080
```

## Core features

- **Library**: search + sort, folders, favorites, up-next queue, a default
  Recently Played playlist, playlist rename/select-all/bulk-remove,
  generated album art, shuffle/repeat, full-screen player with
  lock-screen media controls.
- **42 animated backgrounds** ported from `AnimatedThemeView.java`, pixie
  dust, a storybook page-turn transition, and an orbiting globe title.
- **8-font customization** and **custom RGB accent colors** (Settings).
- **Album art styles** (Settings → Album Art Style): the default gold
  sigil, plus four hazard-themed alternates — Skeleton Hazard, Vicious
  Blood, Chernobyl Vybz (radiation trefoil), and Gas Mask — each with its
  own lit/shaded rendering (a directional highlight-to-shadow gradient and
  specular glints, not flat color fills). Fixed a bug where switching
  styles here didn't actually change the art on screen — `app.js` had its
  own duplicate, sigil-only art generator that shadowed the real one in
  `shared.js`; it now always goes through the shared generator, so style
  changes apply immediately everywhere (library rows, mini-player, full
  player, lock-screen artwork).
- **Custom album art per song** (full player → pencil icon on the
  artwork): pick a photo straight from device storage to use as that
  song's cover instead of the generated art. Any size or aspect ratio
  goes in — it's automatically center-cropped to a square and resized to
  512x512 so it displays correctly and consistently everywhere art shows
  up (library rows, mini-player, full player, lock-screen controls),
  same as the generated styles above. Stored on-device (IndexedDB), so
  it's still there next time you open the app; a second button next to
  the pencil resets a song back to its generated art. 8MB cap per photo,
  nothing ever leaves your device.
- **Monthly & yearly recap**, **video player** with subtitles/multi-
  language audio, and **DJ Mode** — see the sections below.

## Rage Mode (Settings → 🔥 Rage Mode)

An alternate, **opt-in** full-app skin built from your concert-atmosphere
and "Demon's Den" briefs — audio-reactive, not just decorative:

- **Real audio reactivity**: a Web Audio `AnalyserNode` taps the actual
  playing track (not a canned animation) and drives everything below off
  its real bass energy.
- **Ember/pyro field + heat glow**, concentrated low-center like coals or
  stage light, with a heavy vignette at the edges.
- **"Demon's Den" backdrop**: rusted hanging chains that sway with the
  bass, a toxic-green pool with a half-submerged skull, glowing eye-pairs
  lurking in the dark corners, and a faint ruined-skyline silhouette
  (cooling towers + a distant ferris wheel) fading into the fog.
- **Blood drips covering much more of the screen, at a real-world 0.5–1cm
  width**: 16 thick hanging strands (each reaching well down into the
  viewport, not just a short band at the top) plus 55 continuous streaks
  that endlessly roll from just above the top edge all the way past the
  bottom, staggered so the "rain" never stops and never lines up. Every
  strand still has the glossy light/dark reflection streak down its length.
- **Drip Effect picker** (Settings → Drip Effect, only in Rage Mode):
  choose **Blood** (default, red), **Chemical** (toxic green ooze with
  drifting smoke curling up behind it), or **Off** to turn the drip layer
  off entirely. Same geometry and continuous-roll animation either way —
  only the substance (and, for Chemical, the smoke) changes.
- **Selectable background image** (Settings → 🖼 Background Image): four
  full-screen images you can pick between — two Chernobyl-style atomic
  wastelands and two lava/hell caverns — plus an **Upload Photo** tile
  that opens your device's file picker so you can use your own image
  instead. Shows in every mode — Light, Dark, and Rage — not just while
  Rage Mode is on. While Rage Mode is on, picking an image also makes the
  ember/eyes canvas wash translucent instead of drawing its own opaque
  den floor, so the image shows through underneath with the
  drips/embers/eyes layered on top exactly as before; in Light or Dark
  mode the image simply replaces the normal animated theme background.
  Picking "None (default)" goes back to the built-in Demon's Den scene in
  Rage Mode, or the normal animated theme background in Light/Dark mode.
  An uploaded photo is stored on-device (IndexedDB) so it's still there
  next time you open the app, shows up as its own "My Photo" tile you can
  reselect or remove (✕), and re-uploading replaces it. Capped at 8MB per
  photo; nothing is ever uploaded anywhere off your device.
- **Screen-impact shake + flash burst** on real bass drops/onsets.
- **Crowd-chant flavor text** replacing the sidebar's usual line
  ("BASS INCOMING", "MOSH PIT ACTIVE", etc.) while active.
- **Heart-pulse wordmark**: a stylized pulsing heart with an ECG trace
  replaces the rotating globe title while Rage Mode is on.
- **Glitch intro**: a ~1.8s corrupted-transmission effect (RGB channel
  split, scanline sweep, static noise, screen tears) plays once, the
  moment you switch Rage Mode **on** — not on every cold app load.
- App chrome (sidebar, mini-player, tab bar) turns into translucent glass
  panels while active so the scene shows through everywhere, not just the
  player screen.

**Scoping notes, on purpose:**
- This plays **only when you turn it on** in Settings, not automatically
  for every visitor on first load. A forced, unavoidable intense-horror
  intro for anyone who opens what's still fundamentally a music app isn't
  something I wanted to ship as the default — Rage Mode being opt-in was
  the one place I pushed back on the brief as given.
- Everything is stylized canvas/CSS illustration (flat shading, gradients,
  specular highlights) — not the hyper-realistic/8K photorealistic
  imagery described in the brief. That's a hard ceiling of what canvas
  drawing can produce (there's no image-generation tool wired into this
  build), and it's also a deliberate choice: extremely graphic
  photorealistic gore isn't something I wanted to push toward even
  through prompt-engineering-style descriptions.
- The heart-pulse wordmark is a simplified, stylized glyph — not the
  anatomical, severed-vessel imagery described — for the same reason,
  since it replaces a piece of permanent UI chrome.

## DJ Mode (`dj.html`)

A full port of `DJModeActivity.java` + `DJVisualizer.java` — dual decks,
constant-power crossfader, 808/bass-boost filter, pitch control, Auto Mix,
Beat Sync, play-count shoutouts, a battle queue, and 4 beat-reactive
visualizer themes running as a full-page background behind glass cards.

## Video playback & subtitles (`video.html`)

Live search; MKV playback fixed via correct MIME-type wrapping with a
clear in-app explanation when a codec (usually HEVC) genuinely can't be
decoded; auto-detected, language-aware subtitles (SRT→VTT, a **V** key to
cycle languages, a CC picker); multi-language audio-track detection with
an automatic English preference and an AUD picker.

## Still simplified

The lyrics view and automatic ID3-embedded album art extraction aren't
in this pass — songs still default to generated art unless you manually
upload a photo per-song (see "Custom album art per song" above).
