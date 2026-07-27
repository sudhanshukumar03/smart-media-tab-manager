# Features

## Three independent media categories

Music, Lecture, and Movie/TV are tracked separately. Each category has its own active tab. Switching to a movie pauses both music and any running lecture. Switching to a lecture pauses music. Switching to music resumes it. No category ever bleeds into another.

Activating any tab in a category sends one summary notification listing everything that was paused (e.g. "🎬 Movie/Show: Playing Netflix — Paused Spotify, Coursera"), so you always know what the extension changed and why.

---

## Two operating modes

### Manual Mode (default)

You mark one tab as Music and one as Lecture — or one as Movie/TV — using the popup. The extension then watches only those tabs. URL doesn't matter: a tab marked as Music could be anything; switching to it resumes it and pauses the others.

Useful when you want precise control over exactly which tabs count.

### Smart Mode

The extension classifies every tab by URL against three hostname lists. You don't mark anything — just browse normally. Opening Coursera automatically pauses Spotify. Closing it resumes Spotify. Opening Netflix pauses both.

Smart Mode also handles:
- **Work tabs** — GitHub, Replit, Stack Overflow, etc. are "neutral". By default music keeps playing on neutral tabs. Toggle "Play music on work tabs" off to silence it there too.
- **App switching** — when Chrome loses focus (you alt-tab to VS Code, Terminal, etc.), music resumes automatically if "Play music when switching apps" is on.
- **SPA re-classification** — when Spotify loads a new track or YouTube loads a new video, the URL changes. The extension debounces these events (200 ms) and re-classifies the tab once the URL settles, so rapid query-param updates don't each trigger a redundant pause/play cycle.

---

## Conflict resolution

If two tabs in the same category are both audible at once (e.g. Spotify already playing, then YouTube Music autoplays in a background tab), the extension pauses the new one immediately and asks you which source to keep.

**Notification** — a system notification appears with two buttons: "Continue [new site]" and "Continue [existing site]". If you don't respond within 15 seconds, it defaults to keeping whatever was already playing.

**Popup banner** — the same choice is also shown as a banner inside the popup, so you can resolve it without needing the notification to still be visible.

**Remembered preference** — whichever choice you make is saved. The next time those two sites conflict, the extension resolves it silently in your favor without asking again. You can view and clear these preferences on the Settings page.

**Third-tab protection** — if a third tab in the same category appears while a conflict prompt is already open, it's silently paused without spawning a second notification. One prompt per category at a time.

**Badge indicator** — the `!` badge (amber) appears whenever any category has an unresolved conflict, regardless of other playback state. It takes priority over all other badge states so you always notice it.

---

## Background-tab autoplay detection

`onActivated` and `onFocusChanged` only fire when you physically switch to a tab. They miss the case where two same-category tabs both autoplay in the background — for example, two YouTube tabs loading, or Spotify already running while YouTube Music starts in a new tab you never focused.

The `onUpdated` listener watches for `audible` becoming `true` on any tab, regardless of focus, and runs the same conflict-detection logic. Background-tab conflicts are handled the same way as focus-triggered ones.

---

## Two-layer pause and play

### Layer 1 — content script

`content.js` is injected on demand into the target tab and either:
- Clicks a **site-specific play/pause button** (Spotify, SoundCloud, Amazon Music, Tidal, YouTube Music, Pandora, Deezer, Gaana, JioSaavn, Wynk, Hungama, YouTube, Udemy, Coursera, Pluralsight, Frontend Masters, Scrimba, egghead.io), or
- Calls `.pause()` / `.play()` directly on the `<video>` or `<audio>` element

When several media elements exist (an ad, a preview thumbnail, and the main player), the extension picks the most likely "real" one using a scoring heuristic: currently-playing > unmuted > has started > longer than 30 seconds.

The content script waits up to 3 seconds for the player to appear (SPAs often render it after the page shell), then confirms the action worked by checking the element's `.paused` state.

### Layer 2 — browser mute fallback

If Layer 1 can't confirm the action (broken selector, site redesign, injection blocked), the extension falls back to `chrome.tabs.update({ muted: true })`. This mutes at the browser tab level and works on every site without exception.

The extension tracks exactly which tabs it muted. It only ever unmutes those tabs — it never touches a mute you set yourself.

---

## Fade audio

When fade is enabled, volume ramps over ~500 ms before a pause (down to 0, then `.pause()`) and after a play (`.play()` at volume 0, then ramp back up to 1). The Layer 1 confirmation check waits an extra 300 ms after a faded pause to avoid falsely falling back to Layer 2 mid-fade.

---

## Manual pause detection

`content.js` attaches `pause` and `play` event listeners to every `<video>` and `<audio>` element on the page, including ones that load dynamically after the initial page render (caught via `MutationObserver`).

When you manually pause music — clicking Spotify's pause button, pressing spacebar, etc. — the extension notices and sets a flag: it will not auto-resume that tab until you play again manually. This prevents the extension from overriding an intentional pause.

The detection is scoped per element using a `WeakMap`, so the extension pausing one player can't mask a genuine manual pause on a different player that fires in the same event window.

---

## YouTube handling

`youtube.com/watch`, `m.youtube.com`, and `youtu.be` are ambiguous — the same URL covers music videos, lectures, documentaries, and films. `music.youtube.com` is always Music.

For watch pages, four modes are available:

| Mode | Behavior |
|---|---|
| **Ask me** (default) | Popup shows a Music / Lecture / Movie picker for unresolved watch pages. Choice is remembered for future unresolved tabs in the same session. |
| **Always Music** | Every watch page is classified as Music automatically. |
| **Always Lecture** | Every watch page is classified as Lecture automatically. |
| **Always Movie/TV** | Every watch page is classified as Movie/Show automatically. |

The popup picker is always available as a **per-tab override** regardless of the global setting. If your default is "Always Music" but a specific tab is a lecture, you can reclassify it without changing your global preference.

YouTube Shorts (`/shorts/…`), channels, and playlists are classified as neutral — not music, lecture, or movie.

---

## Popup

The toolbar popup shows:

- **Three rows** — Music, Lecture, Movie/TV. Each shows the tab title (truncated to 26 characters), whether the tab is currently audible (live indicator), and a "Set current" button to mark the active tab.
- **Clear button** — unmarks all three tabs at once.
- **Status dot** — color-coded indicator (green = music active, blue = lecture, red = movie, purple = Smart Mode watching).
- **Smart Mode banner** — appears when Smart Mode is on; shows whether "music plays in VS Code" is active.
- **Current tab role** — in Smart Mode, shows how the active tab is classified and what that means for playback (e.g. "📚 Lecture site — music pauses").
- **Conflict banner** — if any category has an unresolved conflict, shows both hostnames and two buttons to resolve it inline.
- **YouTube picker** — if the active tab is an unresolved `youtube.com/watch` page, shows three buttons to classify it as Music, Lecture, or Movie.
- **Same-domain hint** — if two open tabs share the same hostname (e.g. two YouTube tabs), a hint suggests using "Set current" to tell them apart.
- **Closed tab warning** — if a tracked tab was closed, the popup says which one and prompts you to re-mark.

---

## Settings page

| Setting | Default | Description |
|---|---|---|
| Smart Mode | Off | Auto-classifies tabs by URL |
| Play music on work tabs | On | (Smart Mode) Music keeps playing on neutral tabs |
| Play music when switching apps | On | (Smart Mode) Music resumes when Chrome loses focus |
| YouTube handling | Ask me | How to classify watch pages |
| Pause both on neutral tab | Off | (Manual Mode) Pauses both pinned tabs on unmarked tabs |
| Fade audio | Off | ~500 ms volume ramp instead of abrupt cut |
| Desktop notifications | On | Notification on each switch and on conflicts |

**Hostname lists** — three editable text areas, one per category, one hostname per line. Changes take effect as soon as you save. Submitting an empty textarea does not wipe the list — use the "Reset to defaults" button for that.

**Remembered preferences** — shows a summary of per-category "which site wins" choices you've made when resolving conflicts. A single "Forget all preferences" button clears them so the extension will ask again.

---

## Keyboard shortcut

`Ctrl+Shift+M` (Mac: `Cmd+Shift+M`) — cycles between your pinned Music and Lecture tabs:

- On the Music tab → switches to Lecture, pauses Music.
- On the Lecture tab → switches to Music, pauses Lecture.
- On neither → jumps to Lecture (or Music if no Lecture is set) and pauses the other.

Remappable at `chrome://extensions/shortcuts`. Explicit shortcut actions set a ~2-second cooldown so the next `onActivated` event doesn't immediately undo the switch.

---

## Badge

| Badge | Color | Meaning |
|---|---|---|
| **!** | Amber `#FF9800` | Unresolved same-category conflict — open popup to resolve |
| **M** | Green | Music is playing (or will play on next neutral tab switch) |
| **L** | Blue | Active lecture tab |
| **V** | Red | Active movie/TV tab (Smart Mode) |
| **S** | Purple | Smart Mode active, music currently paused |
| *(blank)* | — | No tabs tracked |

`!` overrides all other states. The badge is recalculated — not blanked — whenever a tracked tab closes, so it always reflects the actual current state.

---

## Cooldown and deduplication

**Explicit cooldown** — after any action triggered by the popup or keyboard shortcut, automatic tab-switch triggers on that tab are suppressed for ~2 seconds. Prevents an `onActivated` event firing milliseconds after a manual action from immediately reversing it.

**Duplicate event collapse** — `onActivated` and `onFocusChanged` can both fire for the same physical tab switch. Events for the same tab within 300 ms are collapsed into one handled event.

**SPA URL debounce** — SPAs like Spotify and YouTube can fire several `onUpdated` URL-change events within milliseconds for one logical navigation. The handler waits 200 ms after the last event before re-classifying, so only one classify+pause pass runs per navigation.

---

## Tab lifecycle

When a tab closes, the extension:
- Clears its tab ID and URL from state
- Removes it from the extension's own mute tracking list
- Cancels any pending conflict prompt that referenced it (and dismisses the notification), so notification buttons can't try to act on a dead tab ID
- Recalculates the badge to reflect the new state
- Cleans up all associated cooldown entries, debounce timers, and conflict timeout timers

---

## Supported sites

58 hostnames across 58 services are seeded by default. All three lists are fully editable — add any hostname including self-hosted media servers (Jellyfin, Emby, Plex on your LAN, VLC Web UI).

**Music** (20 services) — Spotify, YouTube Music, SoundCloud, Amazon Music, Apple Music, Tidal, Pandora, Deezer, TuneIn, Bandcamp, Audiomack, Mixcloud, Last.fm, Radio Paradise, Gaana, JioSaavn, Wynk Music, Hungama, Raaga, iRaag

**Lecture** (21 services) — Udemy, Coursera, edX, Khan Academy, Pluralsight, Frontend Masters, Scrimba, egghead.io, Level Up Tutorials, Laracasts, Codecademy, Skillshare, MasterClass, Brilliant, DataCamp, Treehouse, LinkedIn Learning (path-matched: `/learning/…`), O'Reilly, Manning, A Cloud Guru, Cloud Academy

**Movie/TV** (17 services) — Netflix, Prime Video, Disney+, JioHotstar, Hulu, HBO Max, Apple TV+, Paramount+, Peacock, Crunchyroll, Plex, JioCinema, Sony LIV, ZEE5, MX Player, Voot, MultiMovies

---

## Privacy

Zero network requests. No analytics, no telemetry, no external servers. All state is stored locally via `chrome.storage.local`.

| Permission | Why |
|---|---|
| `tabs` / `activeTab` | Read tab URLs and titles; switch focus between tabs |
| `scripting` | Inject `content.js` on demand to control the media element |
| `storage` | Persist settings and tab state locally |
| `notifications` | Alerts on switches and same-category conflicts |
| `windows` | Detect when Chrome loses focus ("play music when switching apps") |
| `host_permissions: <all_urls>` | Allow Smart Mode to classify and control any site, not just the built-in list |
