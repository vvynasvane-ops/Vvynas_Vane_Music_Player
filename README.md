# Vvynas Vane — Web

A web replica of the Vvynas Vane Android music player. This pass corrects
the aesthetic to match the real app (monospace-first, scan-line overlay
over the Westeros gold palette — not a fantasy-serif look) and adds the
features from your last message.

## Files

```
index.html   Library / player / playlists / folders / favorites (main hub)
video.html   Simple, standard video + M4A player — no animation, no transitions
recap.html   Monthly & yearly listening recap, purple starry theme + poster download
shared.js    IndexedDB, 8-font manager, storage access, 42 animated themes,
             pixie dust, book-page transition, orbiting globe title
app.js       Library page logic
video.js     Video page logic
recap.js     Recap page logic
style.css    Shared styling
manifest.json / sw.js   PWA install + offline app shell
```

Run the same way as before — serve over HTTPS or `localhost`:
```bash
cd vvynas-vane-web
python3 -m http.server 8080
# open http://localhost:8080
```

## What changed this pass

**1. Monthly & yearly recap** (`recap.html`) — a direct port of
`RecapActivity`'s own dark-purple starry look (kept separate from the gold
theme, since that's how the source app does it). Toggle Monthly/Yearly,
scroll through months, see listening time / songs played / unique tracks /
top track, a month-by-month bar chart in yearly view, and a "Download My
Recap" button that renders a shareable poster image. Listening time and
play counts are now tracked automatically in the background as you play
(`app.js` writes to a `monthStats` store every ~5s of playback) — recap
data starts accumulating from the moment you start using the web app.

**2. All 42 animated backgrounds** — I read through `AnimatedThemeView.java`
theme by theme (Waves, Volcano, Sunset, Windmill, Waterfall, Undersea,
Smoke, Piano, Thinking, Aurora, Shark, Dog, Cat, Sahara, Darkness, Letter,
Beach, Jamaica, Reggaeton, Firestorm, Galaxy, Zombie, Memory Lane, Wild
West, Fantasy Island, Arctic, Tsunami, Thunderstorm, Skydiving, Moon Walk,
Bar, and the fairytale pack: Fairytale, Witch, Romance R&B, Hip Hop,
Babylon, Sword Night, Dr. Strange, LOTR, Arcane, Star Wars) and ported each
one's actual color palette, layout, and motion to an HTML canvas — same
hex colors, same layered structure, not reinvented. Pick one from Settings
→ "Animated Background." Matching the Android app, the animation only
shows on the full-screen Now Playing view, not behind the library list.
Also ported: **PixieDustView** (a gold-sparkle burst on every tap),
**BookTransitionView** (a storybook double-door page-turn that plays on
every song change), and **GlobeTitleView** (the "VVYNAS VANE" wordmark
orbiting as 3D-style letters in the sidebar header, exactly like the
Android title bar).

**3 & 4. Font customization, 8 families** — Settings → "Font" now shows
all 8 entries from `FontManager.java` (Monospace/default, Serif,
Sans-serif, Condensed, Sans-serif Light, Sans-serif Medium, Sans-serif
Black, Casual) with a live preview, applied instantly across every screen
and persisted. I also corrected the *default* — the real app's default
typeface is monospace everywhere (with a scan-line overlay), which the
first version of this build got wrong by defaulting to a fantasy serif.

**5. Video player** (`video.html`) — intentionally plain: a standard
`<video>` element with play/pause/prev/next/seek, a file list split into
Video Files and M4A Files, no animated backdrop, no page-turn, no time
lapse. Uses the same on-device folder-access flow as the music library.

**6. Multiple HTML files** — split into `index.html` / `video.html` /
`recap.html`, sharing one `shared.js` engine and one IndexedDB database so
playlists, favorites, fonts, and themes stay in sync no matter which page
you're on.

## Still simplified

DJ Mode and its visualizer, the lyrics view, and ID3-embedded album art
(this still uses generated sigil art) are not in this pass — say the word
and I'll port those next using the same read-the-source approach.
