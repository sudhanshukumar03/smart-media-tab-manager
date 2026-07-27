# Smart Media Tab Manager

![Version](https://img.shields.io/badge/version-1.4.0-blue)
![Manifest](https://img.shields.io/badge/manifest-v3-green)
![Browser](https://img.shields.io/badge/browser-Chrome%20%7C%20Brave%20116%2B-orange)

> Automatically pause Spotify when you open a lecture, resume when you switch back — across Chrome and Brave.

Never have music, a lecture, and a movie all fighting for your speakers at once. The extension watches your tabs and keeps exactly one audio source playing at a time — automatically.

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [How It Works](#how-it-works)
- [YouTube](#youtube)
- [Supported Sites](#supported-sites)
- [Settings](#settings)
- [Badge Reference](#badge-reference)
- [Keyboard Shortcut](#keyboard-shortcut)
- [Privacy](#privacy)
- [Files](#files)
- [Known Limitations](#known-limitations)

---

## Features

- **Three independent media categories** — Music, Lecture, and Movie/TV are each tracked separately. Starting a movie pauses your music and lecture; switching back resumes the right one automatically.
- **Smart Mode** — classifies tabs by URL with no manual marking. Switch to GitHub or Replit and music keeps playing. Open Coursera and music pauses. Open Netflix and everything else pauses.
- **Manual Mode** — pin one tab as Music and one as Lecture. Only those two tabs control playback; everything else is ignored.
- **Conflict resolution** — if two music tabs (or two lectures, or two movies) both try to play, the new one is paused immediately and a notification asks which source to keep. Your choice is remembered for that site pairing going forward. If you ignore the prompt for 15 seconds, it defaults to keeping whatever was already playing.
- **Background-tab detection** — catches two tabs autoplaying in the background without you switching between them.
- **Third-tab protection** — if a third tab in the same category appears while a conflict prompt is already open, it is silently paused without spawning a second notification.
- **YouTube ambiguity picker** — `youtube.com/watch` could be music, a lecture, or a movie. A three-button picker in the popup lets you declare which one, per tab.
- **Fade audio** — optionally ramps volume over ~500ms instead of an abrupt cut.
- **Manual pause detection** — if you pause Spotify yourself, the extension backs off and won't resume it automatically until you play again.
- **Keyboard shortcut** — `Ctrl+Shift+M` (`Cmd+Shift+M` on Mac) switches between your pinned Music and Lecture tabs without opening the popup.

---

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or Brave.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin the extension to your toolbar for quick access.

> **After editing any source file**, click the reload icon (↺) on the extension card at `chrome://extensions` to pick up the changes.

**Minimum browser version: Chrome or Brave 116.**

---

## How It Works

### Two modes

| Mode | How to enable | How playback is decided |
|---|---|---|
| **Manual** (default) | Open the popup → click "Set current" on your music tab, then your lecture tab | Purely by tab ID — URLs are ignored entirely |
| **Smart** | Options page → enable Smart Mode | Classifies every tab by URL against editable hostname lists |

### Two-layer pause/play

**Layer 1** injects `content.js` into the target tab and calls `.pause()` / `.play()` directly on the media element — or clicks a site-specific play/pause button for sites that need it. This preserves playback position, stops audio processing, and keeps the site's own player UI in sync.

**Layer 2** is the fallback. If Layer 1 can't confirm the action worked (broken selector, site redesign, injection blocked), the extension falls back to `chrome.tabs.update({ muted: true })`. This mutes the tab at the browser level and works on every site without exception. Audio keeps running, just silently. The extension tracks which tabs *it* muted and only ever un-mutes those — it never touches a mute you set yourself.

### Cooldown and deduplication

Three things can trigger a playback change: tab switches (automatic), the popup, and the keyboard shortcut.

1. Explicit actions (popup or shortcut) always win immediately.
2. For ~2 seconds after an explicit action, automatic triggers on that same tab are suppressed — so a manual pause can't be instantly overridden by a tab-switch event that fires a split second later.
3. Automatic triggers resume normally after the cooldown expires.

`onActivated` and `onFocusChanged` can both fire for the same physical tab switch. Duplicate events for the same tab within 300 ms are collapsed into a single handled event.

---

## YouTube

`youtube.com/watch`, `m.youtube.com`, and `youtu.be` are ambiguous — the same URL pattern covers music videos, lectures, and full films. `music.youtube.com` is unambiguous and is always treated as Music.

| Setting | Behavior |
|---|---|
| **Ask me** (default) | The popup shows a Music / Lecture / Movie picker when you land on an unresolved watch page. Your choice is remembered for future tabs in the same session. |
| **Always Music** | Every `youtube.com/watch` tab is automatically classified as Music. |
| **Always Lecture** | Every `youtube.com/watch` tab is automatically classified as a Lecture. |
| **Always Movie/TV** | Every `youtube.com/watch` tab is automatically classified as a Movie/Show. |

The popup picker is always available as a **per-tab override** regardless of your global setting — useful when your default is "Always Music" but a specific tab is a lecture.

---

## Supported Sites

All three lists are fully editable in Settings — one hostname per line. Changes take effect immediately on save. You can add any site, including self-hosted media servers.

<details>
<summary><strong>🎵 Music</strong> — 20 sites</summary>

| Site | Hostname |
|---|---|
| Spotify | `open.spotify.com` |
| YouTube Music | `music.youtube.com` |
| SoundCloud | `soundcloud.com` |
| Amazon Music | `music.amazon.com` |
| Apple Music | `music.apple.com` |
| Tidal | `tidal.com` |
| Pandora | `pandora.com` |
| Deezer | `deezer.com` |
| TuneIn | `tunein.com` |
| Bandcamp | `bandcamp.com` |
| Audiomack | `audiomack.com` |
| Mixcloud | `mixcloud.com` |
| Last.fm | `last.fm` |
| Radio Paradise | `radioparadise.com` |
| Gaana | `gaana.com` |
| JioSaavn | `jiosaavn.com` |
| Wynk Music | `wynk.in` |
| Hungama | `hungama.com` |
| Raaga | `raaga.com` |
| iRaag | `iraag.net` |

</details>

<details>
<summary><strong>🎓 Lecture</strong> — 21 sites</summary>

| Site | Hostname |
|---|---|
| Udemy | `udemy.com` |
| Coursera | `coursera.org` |
| edX | `edx.org` |
| Khan Academy | `khanacademy.org` |
| Pluralsight | `pluralsight.com` |
| Frontend Masters | `frontendmasters.com` |
| Scrimba | `scrimba.com` |
| egghead.io | `egghead.io` |
| Level Up Tutorials | `leveluptutorials.com` |
| Laracasts | `laracasts.com` |
| Codecademy | `codecademy.com` |
| Skillshare | `skillshare.com` |
| MasterClass | `masterclass.com` |
| Brilliant | `brilliant.org` |
| DataCamp | `datacamp.com` |
| Treehouse | `teamtreehouse.com` |
| LinkedIn Learning | `linkedin.com/learning/*` |
| O'Reilly | `oreilly.com` |
| Manning | `manning.com` |
| A Cloud Guru | `acloudguru.com` |
| Cloud Academy | `cloudacademy.com` |

> LinkedIn Learning is detected by path (`/learning/…`) — the full `linkedin.com` domain is not blocked.

</details>

<details>
<summary><strong>🎬 Movie/TV</strong> — 17 sites</summary>

| Site | Hostname |
|---|---|
| Netflix | `netflix.com` |
| Prime Video | `primevideo.com` |
| Disney+ | `disneyplus.com` |
| JioHotstar | `hotstar.com` |
| Hulu | `hulu.com` |
| HBO Max | `max.com` |
| Apple TV+ | `tv.apple.com` |
| Paramount+ | `paramountplus.com` |
| Peacock | `peacocktv.com` |
| Crunchyroll | `crunchyroll.com` |
| Plex | `app.plex.tv` / `watch.plex.tv` |
| JioCinema | `jiocinema.com` |
| Sony LIV | `sonyliv.com` |
| ZEE5 | `zee5.com` |
| MX Player | `mxplayer.in` |
| Voot | `voot.com` |
| MultiMovies | `multimovies.study` |

> Self-hosted players (Jellyfin, Emby, Plex on your LAN, VLC Web UI) don't have a fixed public hostname. Add yours in Settings → Movie/TV sites.

</details>

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| **Smart Mode** | Off | Auto-classifies tabs by URL instead of requiring manual marking |
| **Play music on work tabs** | On | (Smart Mode) Keeps music playing when you switch to neutral tabs — GitHub, Replit, docs, etc. |
| **Play music when switching apps** | On | (Smart Mode) Resumes music when Chrome/Brave loses focus — alt-tabbing to VS Code, Terminal, etc. |
| **YouTube handling** | Ask me | How to classify `youtube.com/watch` tabs — Ask / Always Music / Always Lecture / Always Movie/TV |
| **Pause both on neutral tab** | Off | (Manual Mode) Pauses both pinned tabs when you navigate to an unmarked tab |
| **Fade audio** | Off | Ramps volume over ~500ms before pausing, instead of cutting instantly |
| **Desktop notifications** | On | Brief notification on each playback switch and on same-category conflicts |

---

## Badge Reference

The icon badge shows the current playback state at a glance.

| Badge | Colour | Meaning |
|---|---|---|
| **!** | 🟠 Amber | A same-category conflict is waiting for your choice — open the popup to resolve it |
| **M** | 🟢 Green | Music is playing (or will play on your next neutral-tab switch) |
| **L** | 🔵 Blue | On the active lecture tab |
| **V** | 🔴 Red | On a movie/TV tab (Smart Mode) |
| **S** | 🟣 Purple | Smart Mode is active but music is currently paused |
| *(blank)* | — | No tabs are marked / tracked |

`!` takes priority over all other states — if you see it, a conflict is pending regardless of what else is playing.

---

## Keyboard Shortcut

**`Ctrl+Shift+M`** (Mac: **`Cmd+Shift+M`**) — cycles between your pinned Music and Lecture tabs without opening the popup.

- If you're on the Music tab → switches to Lecture and pauses Music.
- If you're on the Lecture tab → switches to Music and pauses Lecture.
- If you're on neither → jumps to the Lecture tab (or Music if no Lecture is pinned).

Remap the shortcut at `chrome://extensions/shortcuts`. If a shortcut doesn't respond, check that page — Chrome silently skips registering one that's already claimed by another extension.

---

## Privacy

This extension makes **zero network requests**. No analytics, no telemetry, no external servers of any kind. All processing happens locally in your browser.

| Permission | Why it's needed |
|---|---|
| `tabs` / `activeTab` | Read tab URLs and titles to classify them; switch focus between pinned tabs |
| `scripting` | Inject `content.js` on demand to control playback via the media element |
| `storage` | Save settings and tab state locally via `chrome.storage.local` |
| `notifications` | Desktop alerts on tab switches and same-category conflicts |
| `windows` | Detect when Chrome/Brave loses focus (for "play music when switching apps") |
| `host_permissions: <all_urls>` | Allow Smart Mode to classify and control any site, not just the built-in list |

---

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest — permissions, service worker, keyboard commands |
| `background.js` | Service worker — all state, URL classification, tab switching, conflict resolution, badge |
| `content.js` | Injected into tabs on demand — media element control, fade, manual pause detection |
| `popup.html` / `popup.js` / `popup.css` | Toolbar popup UI |
| `options.html` / `options.js` / `options.css` | Settings page |
| `FEATURES.md` | Full feature reference — every behaviour documented in one place |
| `PERFORMANCE_NOTES.md` | Internal performance notes — batched storage writes, tab-fetch consolidation, listener hygiene |

---

## Known Limitations

- **Auto tag always shown in Smart Mode** — the "auto" label on a tracked tab appears whether the extension found it automatically or you pinned it manually via "Set current". There's no stored distinction between the two.
- **Site-specific selectors can fall behind** — if a site redesigns its player UI, the content script falls back to controlling the raw `<video>`/`<audio>` element directly. Playback still works, but the site's own player UI may not update its play/pause state visually.
- **One conflict prompt per category** — if three music tabs are playing simultaneously, only one conflict notification appears. The third tab is silently paused in the background. Once you resolve the first conflict, the extension re-evaluates.
- **Occasional double-event on tab switch** — `onActivated` and `onFocusChanged` can both fire for the same physical switch. This is de-duplicated internally and settles in under 300 ms — you will never hear audio from both tabs simultaneously.
- **Service worker restarts** — Chrome can suspend the service worker when the extension is idle. In-memory conflict timeout timers are lost on restart. Pending conflicts stored in `chrome.storage.local` remain, but the 15-second auto-dismiss timer resets to the next user interaction rather than counting down.
