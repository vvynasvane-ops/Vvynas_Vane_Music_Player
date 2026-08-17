# Vvynas Vane — Web

A web replica of the Vvynas Vane Android music player: your local song
library, playlists (with rename/sort/multi-select-remove), a default
Recently Played playlist, an editable up-next queue, favorites, folders,
monthly/yearly recap, a video player with search/subtitles/multi-language
audio, DJ Mode, and a full-screen player with 42 animated backgrounds —
all running in the browser. No file is ever uploaded; everything plays
straight from the folder you grant access to, on-device.

## Files

```
index.html   Library / player / playlists / folders / favorites / recently played
video.html   Video + M4A player — search, subtitles, multi-audio-track support
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
  sigil art, shuffle/repeat, full-screen player with lock-screen media
  controls.
- **Up-next queue**: every song row now has a queue icon to add it right
  after the currently playing track (or start playback if nothing's
  playing) — separate from the ⋮ "add to playlist" menu. The Up Next sheet
  itself now has a remove (✕) button per queued track.
- **Recently Played** — a default, always-present system playlist that
  records every song you play (most-recent-first, capped at 100),
  reachable from the sidebar or as a pinned card at the top of Playlists.
  Supports the same sort/select-all/remove tools as user playlists, plus a
  one-tap "Clear" for the whole history.
- **Playlists**: create, **rename** (pencil icon), delete, and — new —
  **select-all + bulk remove** songs from any playlist, Favorites, or
  Recently Played via a "Select" toggle that turns rows into checkboxes.
  Sorting (the same title/artist/album/duration/size/year/date/play-count
  dropdown used everywhere) already applies inside every playlist,
  Favorites, and Recently Played too.
- **42 animated backgrounds**, ported theme-by-theme from
  `AnimatedThemeView.java`, plus pixie-dust tap sparkles, a storybook
  page-turn transition, and an orbiting globe-title wordmark.
- **8-font customization** (Settings → Font), applied live app-wide.
- **Monthly & yearly recap** (`recap.html`): purple-starry screen matching
  `RecapActivity`'s own palette, with a downloadable poster.
- **Video player** (`video.html`) — search, subtitles, and multi-language
  audio; see below for details.
- **DJ Mode** (`dj.html`): dual decks, real crossfader, bass boost, Auto
  Mix, Beat Sync, play-count shoutouts, a battle queue, and 4 beat-reactive
  visualizer themes running as a true full-page background — ported from
  `DJModeActivity.java` / `DJVisualizer.java`.
- **Connecting overlay**: an hourglass loader with cycling status text
  while granting/resuming folder access, instead of a frozen screen.
- **Installable**: manifest + service worker power "Add to Home Screen,"
  available from the sidebar/Settings — not pushed on first load.
- **Dark mode**: true near-black (`#000000`/`#050505`/`#0B0B0B`) across the
  whole app, with the gold/crimson accents kept intact.
- **Responsive**: sidebar + wide player on tablet/laptop, bottom tab bar +
  compact player on phones.

## Video playback & subtitles (`video.html`)

**Search.** A live search bar filters the Video Files / M4A Files lists
instantly by filename. Press **/** to focus it, **Esc** to clear it.

**MKV support.** Every file is re-wrapped in a `Blob` with the correct
MIME type before playback (browsers/OSes frequently mis-detect `.mkv`),
which fixes playback for the large majority of real-world MKV rips. If a
video track still can't be decoded (usually HEVC/H.265), the player
detects and explains that directly instead of leaving a silent black
screen with audio-only playback.

**Subtitles — auto-detected, with language recognition.** Drop `.srt`/
`.vtt` files next to a video with a matching filename and they're
auto-detected the moment you play it. Language-tagged filenames
(`Movie.en.srt`, `Movie.fr.srt`, etc. — 20 common codes/names) are
recognized, and English is auto-selected first if present. Press **V**
anytime to cycle subtitle languages (the same convention VLC uses); the
**CC** button opens a picker.

**Multi-language audio, with an English recommendation.** Uses the native
`audioTracks` API (Chrome/Edge/Opera). If a file has multiple audio
tracks and one is English, it's switched to automatically with a toast
explaining what happened; otherwise you're prompted to choose via the
**AUD** button.

## DJ Mode (`dj.html`)

A full port of `DJModeActivity.java` + `DJVisualizer.java` — dual decks
each on their own Web Audio graph, a constant-power crossfader, an
808/bass-boost low-shelf filter, per-deck pitch control, Auto Mix, Beat
Sync, the original Game-of-Thrones-flavored play-count shoutouts, a
battle queue, and 4 beat-reactive visualizer themes (DRAGONFIRE /
LANNISTER / STARK WINTER / NIGHT KING) running as a true full-page
background behind glass-panel cards.

Reachable from the sidebar, the Settings modal, or directly at `dj.html`.

## Fix log

- Removed the "Add to Home Screen" prompt from first-load onboarding.
- Added hourglass/orbit/track/dot loaders in fitting spots across the app.
- Fixed a mobile tab-bar visibility bug after resize/rotation.
- Fixed folder-picker cancellation during a rescan stranding you on the
  "Grant Access" screen.
- Fixed a double-binding bug on every "Grant Access" button that could pop
  an unwanted folder picker when resuming access.
- Fixed MKV files frequently failing to show video (playing audio only) by
  correcting MIME-type detection.
- Added subtitle support with automatic sibling-file + language detection,
  SRT→VTT conversion, a "V" keyboard shortcut, and a CC picker.
- Added multi-language audio-track detection with an automatic English
  preference and an AUD picker for manual selection.
- Added live search to the video page, with `/` and `Esc` shortcuts.
- Tuned DJ Mode's visualizer to run as a true full-page background with
  glass-panel cards and reduced animation intensity.
- Pushed dark mode to true near-black across the whole app.
- Added an up-next queue-add action per song, a default Recently Played
  playlist, playlist rename, and select-all/bulk-remove across playlists,
  Favorites, and Recently Played.

## Still simplified

The lyrics view and ID3-embedded album art (this still uses generated
sigil art) aren't in this pass — say the word and they can be ported next
the same way, straight from the source.
