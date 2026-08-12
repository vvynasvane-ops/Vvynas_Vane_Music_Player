# Vvynas Vane — Web

A full web replica of the Vvynas Vane Android music player: your local song
library, playlists, folders, favorites, and a full-screen player, all running
in the browser. No file is ever uploaded — everything plays straight from
the folder you grant access to, on-device.

## Running it

This app needs to be served over **HTTPS or `localhost`** — that's a browser
security requirement for the storage-access and install features below, not
something specific to this app. Opening `index.html` directly via
`file://` will mostly work but the "remember my folder" and "add to home
screen" features won't.

**Quickest local test:**
```bash
cd vvynas-vane-web
python3 -m http.server 8080
# open http://localhost:8080
```

**To make it reachable from your phone/tablet on the same network**, use
your computer's LAN IP instead of `localhost`, or deploy it (see below).

**To deploy for real** (so it works everywhere, including "Add to Home
Screen"), push this folder to GitHub Pages, Netlify, Vercel, or any static
host — no build step, no server-side code required.

## What it does

- **Grant Access to Your Music**: uses the File System Access API
  (`showDirectoryPicker`) on Chrome/Edge/Opera/Android Chrome to let you
  pick a folder — the app remembers it next time (with a one-tap "Resume
  Access" permission re-grant). On Firefox/Safari/iOS, it falls back to a
  standard folder file-picker input; those browsers will ask you to
  re-select the folder each visit since they don't support persistent
  folder handles yet.
- **Library**: search, and sort by title, artist, album, duration, file
  size, year, date added, or play count — same fields as the Android app's
  `Song` model.
- **Folders**: browse by the actual folder structure of your files.
- **Playlists**: create, add/remove songs, delete.
- **Favorites**: heart any song; tracked play counts per song.
- **Player**: full-screen player with seek bar, shuffle, repeat
  (off/all/one), up-next queue sheet, and lock-screen/notification media
  controls via the Media Session API.
- **Themes**: the Westeros gold/crimson palette from your Android app's
  `colors.xml`, plus a light mode toggle.
- **Installable**: manifest + service worker so "Add to Home Screen" works
  on Android/desktop Chrome (native install prompt) and iOS Safari (Share →
  Add to Home Screen, with in-app instructions since iOS doesn't expose an
  install prompt).
- **Responsive**: sidebar + wide player on tablet/laptop, bottom tab bar +
  compact player on phones.

## What's not in this pass

This covers the core listening experience. It does **not** yet include DJ
Mode, the lyrics view, the monthly recap image, video/MP4 playback, or the
fairytale/witch/etc. animated theme packs from later Android builds — the
scaffolding (theme system, canvas ember effect, per-song generated art) is
in place to extend into those next if you want them.

Album art is generated (a deterministic gold sigil per song) rather than
read from embedded ID3 tags, to keep the app dependency-free and reliable
offline; that's the one deliberate simplification versus the Android app's
`Glide`-loaded album art.
