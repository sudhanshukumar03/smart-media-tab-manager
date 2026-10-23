// background.js — service worker for Smart Media Tab Manager
//
// Modes:
//   Manual — user marks a Music tab + Lecture tab via popup. Switching controls playback.
//   Smart  — auto-classifies tabs by URL into categories (music / lecture / movie / work / neutral)
//            and runs everything through the MediaManager below so only one tab per
//            category ever plays audio at a time — even across different websites
//            (Spotify vs YouTube Music vs Amazon Music are all "music", for example).
//
// Layer 1: content.js tries a real pause()/play() on the media element.
// Layer 2: if Layer 1 can't confirm it worked, fall back to chrome.tabs.update mute.
//          We track which tabs WE muted so we never unmute something the user muted.
//
// Cooldown: after any explicit action (popup/shortcut), auto-triggers on that
//           tab are suppressed for ~2s so an explicit action can't be immediately
//           overridden by a tab-switch event firing milliseconds later.
//
// Conflict resolution: when a second tab in the SAME category (e.g. two music tabs)
// is actually audible at once, we never let both play. We ask the user which one to
// keep via a system notification with two buttons, default safely to "pause the new
// one, keep what's already playing" if they don't respond, and remember their choice
// per-hostname so the same pairing won't ask again.
//
// State writes: chrome.storage.local get/set is not atomic across concurrent callers.
// onActivated and onFocusChanged can both fire for a single physical tab switch, so all
// setState() calls are serialized through a tiny in-memory queue (see _stateQueue) to
// avoid a lost-update race where two concurrent read-modify-write calls clobber each other.

// default hostname lists — seeded into storage on first run
// edit from the Options page, not here

const DEFAULT_MUSIC_HOSTNAMES = [
  // Global streaming
  'open.spotify.com',
  'music.youtube.com',
  'soundcloud.com',
  'music.amazon.com',
  'tidal.com',
  'pandora.com',
  'deezer.com',
  'music.apple.com',
  'tunein.com',
  'bandcamp.com',
  'audiomack.com',
  'mixcloud.com',
  'last.fm',
  'radioparadise.com',
  // Indian music platforms
  'gaana.com',
  'jiosaavn.com',
  'saavn.com',          // old domain, still resolves
  'wynk.in',            // Wynk Music (Airtel)
  'hungama.com',        // Hungama Music
  'raaga.com',
  'iraag.net',
];

const DEFAULT_LECTURE_HOSTNAMES = [
  'udemy.com',
  'coursera.org',
  'edx.org',
  'khanacademy.org',
  'pluralsight.com',
  'frontendmasters.com',
  'scrimba.com',
  'egghead.io',
  'leveluptutorials.com',
  'laracasts.com',
  'codecademy.com',
  'skillshare.com',
  'masterclass.com',
  'brilliant.org',
  'datacamp.com',
  'teamtreehouse.com',
  'oreilly.com',
  'manning.com',
  'acloudguru.com',
  'cloudacademy.com',
];

// Movies / TV / streaming — tracked independently from Music and Lecture.
// Self-hosted servers (Jellyfin, Emby, Plex-on-LAN, VLC Web UI) don't have a fixed
// public hostname, so they aren't seeded here — users can add their own via Options,
// same as any other custom hostname.
const DEFAULT_MOVIE_HOSTNAMES = [
  'netflix.com',
  'primevideo.com',
  'disneyplus.com',
  'hotstar.com',
  'sonyliv.com',
  'zee5.com',
  'mxplayer.in',
  'tv.apple.com',
  'hulu.com',
  'max.com',
  'hbomax.com',
  'crunchyroll.com',
  'app.plex.tv',
  'watch.plex.tv',
  'peacocktv.com',
  'paramountplus.com',
  'voot.com',
  'jiocinema.com',
  'multimovies.study',
];

// Friendly display names for notifications / conflict prompts. Falls back to the
// raw hostname when a site isn't listed here — never hardcode logic on this map,
// it's cosmetic only.
const SITE_LABELS = {
  // Music — global
  'open.spotify.com': 'Spotify',
  'music.youtube.com': 'YouTube Music',
  'youtube.com': 'YouTube',
  'm.youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'soundcloud.com': 'SoundCloud',
  'music.amazon.com': 'Amazon Music',
  'tidal.com': 'Tidal',
  'pandora.com': 'Pandora',
  'deezer.com': 'Deezer',
  'music.apple.com': 'Apple Music',
  'tunein.com': 'TuneIn',
  'bandcamp.com': 'Bandcamp',
  'audiomack.com': 'Audiomack',
  'mixcloud.com': 'Mixcloud',
  'last.fm': 'Last.fm',
  'radioparadise.com': 'Radio Paradise',
  // Music — Indian
  'gaana.com': 'Gaana',
  'jiosaavn.com': 'JioSaavn',
  'saavn.com': 'JioSaavn',
  'wynk.in': 'Wynk Music',
  'hungama.com': 'Hungama',
  'raaga.com': 'Raaga',
  'iraag.net': 'iRaag',
  // Lecture
  'udemy.com': 'Udemy',
  'coursera.org': 'Coursera',
  'edx.org': 'edX',
  'khanacademy.org': 'Khan Academy',
  'pluralsight.com': 'Pluralsight',
  'frontendmasters.com': 'Frontend Masters',
  'scrimba.com': 'Scrimba',
  'egghead.io': 'egghead.io',
  'leveluptutorials.com': 'Level Up Tutorials',
  'laracasts.com': 'Laracasts',
  'codecademy.com': 'Codecademy',
  'skillshare.com': 'Skillshare',
  'masterclass.com': 'MasterClass',
  'brilliant.org': 'Brilliant',
  'datacamp.com': 'DataCamp',
  'teamtreehouse.com': 'Treehouse',
  'oreilly.com': "O'Reilly",
  'manning.com': 'Manning',
  'acloudguru.com': 'A Cloud Guru',
  'cloudacademy.com': 'Cloud Academy',
  'linkedin.com': 'LinkedIn Learning',
  // Movies / TV
  'netflix.com': 'Netflix',
  'primevideo.com': 'Prime Video',
  'disneyplus.com': 'Disney+',
  'hotstar.com': 'JioHotstar',
  'sonyliv.com': 'Sony LIV',
  'zee5.com': 'ZEE5',
  'mxplayer.in': 'MX Player',
  'tv.apple.com': 'Apple TV+',
  'hulu.com': 'Hulu',
  'max.com': 'HBO Max',
  'hbomax.com': 'HBO Max',
  'crunchyroll.com': 'Crunchyroll',
  'app.plex.tv': 'Plex',
  'watch.plex.tv': 'Plex',
  'peacocktv.com': 'Peacock',
  'paramountplus.com': 'Paramount+',
  'voot.com': 'Voot',
  'jiocinema.com': 'JioCinema',
  'multimovies.study': 'MultiMovies',
};

function labelFor(hostname) {
  if (!hostname) return 'this tab';
  return SITE_LABELS[hostname] || hostname;
}

// Extensible category registry. Adding a new category later means
// adding one entry here plus a hostname list — nothing else is hardcoded on
// "music"/"lecture"/"movie" strings beyond this table and its derived maps.
const CATEGORIES = ['music', 'lecture', 'movie'];
const CATEGORY_TAB_FIELD   = { music: 'musicTabId',   lecture: 'lectureTabId',   movie: 'movieTabId'   };
const CATEGORY_URL_FIELD   = { music: 'musicUrl',     lecture: 'lectureUrl',     movie: 'movieUrl'     };
const CATEGORY_LABEL       = { music: 'Music',        lecture: 'Lecture',       movie: 'Movie/Show'   };
const CATEGORY_EMOJI       = { music: '🎵',           lecture: '🎓',           movie: '🎬'           };
const CATEGORY_DEFAULT_HOSTNAMES = { music: DEFAULT_MUSIC_HOSTNAMES, lecture: DEFAULT_LECTURE_HOSTNAMES, movie: DEFAULT_MOVIE_HOSTNAMES };
const CATEGORY_HOSTNAME_FIELD = { music: 'musicHostnames', lecture: 'lectureHostnames', movie: 'movieHostnames' };

// after an explicit action, suppress auto-triggers on that tab for this long
const COOLDOWN_MS = 2000;
const _explicitCooldown = new Map(); // tabId → { time, source, action }

// guards against onActivated + onFocusChanged both firing handleTabSwitch for
// the same physical tab switch (which would double-run play/pause + notify)
const DUPLICATE_SWITCH_MS = 300;
let _lastHandledSwitch = { tabId: null, time: 0 };

// Same-category conflict prompts auto-resolve to "keep what's already playing"
// if the user doesn't respond within this window (in-memory timers only — a
// service-worker restart mid-conflict just means the prompt waits for a click
// instead, which is a safe degradation).
const CONFLICT_TIMEOUT_MS = 15000;
const _conflictTimeoutTimers = new Map(); // category → timeoutId

// These fire on every explicit action and every auto-trigger check — i.e. on
// nearly every tab switch. Gate the verbose per-event tracing behind a flag so
// template-string building (and the console call itself) is skipped by default;
// flip to true only when actively debugging cooldown/conflict behavior.
const DEBUG_LOGGING = false;

function setExplicitCooldown(tabId, source, action) {
  if (!tabId) return;
  _explicitCooldown.set(tabId, { time: Date.now(), source, action });
  if (DEBUG_LOGGING) console.log(`[SMTM] Explicit action — tabId:${tabId} source:${source} action:${action}`);
}

function checkCooldown(tabId, autoSource) {
  const entry = _explicitCooldown.get(tabId);
  if (!entry) {
    if (DEBUG_LOGGING) console.log(`[SMTM] Auto trigger — tabId:${tabId} source:${autoSource} (no cooldown)`);
    return false;
  }
  const inCooldown = Date.now() - entry.time < COOLDOWN_MS;
  if (DEBUG_LOGGING) {
    if (inCooldown) {
      console.log(`[SMTM] Auto trigger SUPPRESSED — tabId:${tabId} source:${autoSource} (explicit ${entry.source}/${entry.action} ${Date.now() - entry.time}ms ago)`);
    } else {
      console.log(`[SMTM] Auto trigger — tabId:${tabId} source:${autoSource} (cooldown expired)`);
    }
  }
  return inCooldown;
}

function hostnameOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

// Shared "is this tab actually making audible sound" check.
// tab.audible alone is not sufficient — a tab that WE layer-2-muted can still
// report audible:true while producing no actual sound. Always use this helper
// instead of checking tab.audible directly in conflict-detection paths.
function isTabActuallyPlaying(tab, extMutedTabIds) {
  return tab.audible === true && !(extMutedTabIds || []).includes(tab.id);
}

// returns 'music' | 'lecture' | 'movie' | 'neutral'
// unresolved youtube.com/watch in 'ask' mode → neutral (never silently pause anything)
function classifyUrl(url, config = {}) {
  if (!url) return 'neutral';
  if (
    url.startsWith('chrome://') ||
    url.startsWith('brave://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('chrome-extension://')
  ) return 'neutral';

  const hostnamesByCategory = config.hostnamesByCategory || CATEGORY_DEFAULT_HOSTNAMES;

  try {
    const u        = new URL(url);
    const hostname = u.hostname.replace(/^www\./, '');

    const isYoutubeHost = hostname === 'youtube.com' || hostname === 'm.youtube.com' || hostname === 'youtu.be';
    const isWatchPath =
      hostname === 'youtu.be' ||                      // youtu.be/<id> is always a "watch"
      u.pathname.startsWith('/watch') ||
      u.pathname.startsWith('/live/');

    // 1. Exact hostname match across all categories
    for (const category of CATEGORIES) {
      const list = hostnamesByCategory[category] || CATEGORY_DEFAULT_HOSTNAMES[category];
      if (list.includes(hostname)) return category;
    }

    // 2. Subdomain/domain suffix matching (e.g. user entered "spotify.com", matches "open.spotify.com")
    // Skip youtube.com/youtu.be here so watch/live paths and music.youtube.com aren't swallowed
    if (!isYoutubeHost) {
      for (const category of CATEGORIES) {
        const list = hostnamesByCategory[category] || CATEGORY_DEFAULT_HOSTNAMES[category];
        if (list.some((d) => d && d.includes('.') && (hostname === d || hostname.endsWith('.' + d)))) {
          return category;
        }
      }
    }

    if (isYoutubeHost && isWatchPath) {
      const mode = (config.youtubeMode && config.youtubeMode !== 'ask') ? config.youtubeMode : (config.youtubeLastChoice || 'lecture');
      return CATEGORIES.includes(mode) ? mode : 'lecture';
    }

    // LinkedIn Learning
    if (hostname === 'linkedin.com' && u.pathname.startsWith('/learning')) return 'lecture';

    return 'neutral'; // Replit, GitHub, Stack Overflow, MDN, Figma, docs, etc.
  } catch {
    return 'neutral';
  }
}

const STATE_KEY = 'smtm_state';

const DEFAULT_STATE = {
  musicTabId:          null,
  lectureTabId:        null,
  movieTabId:          null,
  musicUrl:            null,
  lectureUrl:          null,
  movieUrl:            null,
  // true when the user manually paused their music. Extension will NOT
  // auto-resume until the user plays again or switches to the music tab.
  userManuallyStopped: false,
  // Tab IDs that WE muted via the Layer 2 fallback. Never unmute a tab that
  // isn't in this list — that could be a mute the user set themselves.
  extMutedTabIds:      [],
  // Editable site classification lists — seeded from the DEFAULT_* arrays
  // above on first run, then fully user-editable from the Options page.
  musicHostnames:      [...DEFAULT_MUSIC_HOSTNAMES],
  lectureHostnames:    [...DEFAULT_LECTURE_HOSTNAMES],
  movieHostnames:      [...DEFAULT_MOVIE_HOSTNAMES],
  // Conflicts awaiting a user decision, keyed by category. Persisted (not just
  // in-memory) so the popup can render/resolve them too, and so a service-worker
  // restart mid-conflict doesn't lose the notification's context.
  pendingConflicts:    {},
  settings: {
    pauseBothWhenElsewhere: false,  // Manual mode: pause both on neutral tab
    fadeAudio:              false,
    notifyOnSwitch:         true,
    smartMode:              true,
    // Smart Mode sub-settings:
    playMusicOnAppSwitch:   true,   // Play music when Brave loses focus (VS Code, minimise…)
    playMusicOnWorkTabs:    true,   // Play music on neutral tabs (Replit, GitHub, docs…)
    // YouTube watch pages default to 'lecture' so videos pause on tab switch and don't clash with music
    youtubeMode:            'lecture',
    youtubeLastChoice:      null,
    // Per-category "which site wins" memory — remembered until the user changes it.
    // e.g. { music: 'open.spotify.com', lecture: null, movie: null }
    categoryPreference:     { music: null, lecture: null, movie: null },
  },
};

function readStateRaw() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STATE_KEY, (result) => {
      const stored = result[STATE_KEY] || {};
      // Migrate the old boolean `youtubeMusicMode` setting (pre-tri-state) if present.
      let migratedYoutubeMode;
      if (stored.settings && typeof stored.settings.youtubeMusicMode === 'boolean' && !stored.settings.youtubeMode) {
        migratedYoutubeMode = stored.settings.youtubeMusicMode ? 'music' : 'lecture';
      }
      resolve({
        ...DEFAULT_STATE,
        ...stored,
        settings: {
          ...DEFAULT_STATE.settings,
          ...(stored.settings || {}),
          categoryPreference: {
            ...DEFAULT_STATE.settings.categoryPreference,
            ...((stored.settings && stored.settings.categoryPreference) || {}),
          },
          ...(migratedYoutubeMode ? { youtubeMode: migratedYoutubeMode } : {}),
        },
      });
    });
  });
}

async function getState() {
  // getState is a plain read — safe to call concurrently. Only writes need serializing.
  return readStateRaw();
}

// --- serialized state writer ---------------------------------------------
// chrome.storage.local get→modify→set is not atomic. Two listeners
// (onActivated + onFocusChanged) can both fire for one tab switch and race:
// both read the same "current" snapshot, then the second write clobbers the
// first. _stateQueue chains every setState call onto a single promise so
// read-modify-write pairs never interleave.
let _stateQueue = Promise.resolve();

function setState(updates) {
  const run = async () => {
    const current = await readStateRaw();
    const next = { ...current, ...updates };
    await new Promise((resolve) => {
      chrome.storage.local.set({ [STATE_KEY]: next }, resolve);
    });
    return next;
  };
  // chain onto the queue regardless of prior success/failure so one bad
  // write can't wedge all future state updates
  const result = _stateQueue.then(run, run);
  _stateQueue = result.then(() => {}, () => {});
  return result;
}

function classifyConfig(state) {
  return {
    hostnamesByCategory: {
      music:   state.musicHostnames,
      lecture: state.lectureHostnames,
      movie:   state.movieHostnames,
    },
    youtubeMode:       state.settings.youtubeMode,
    youtubeLastChoice: state.settings.youtubeLastChoice,
  };
}

// Pinned tab IDs win over URL-based classification. A tab the user has
// explicitly marked (via popup or Smart Mode auto-pin) is always treated
// as that category regardless of what URL it currently shows — important
// for two-YouTube-tabs cases and for tabs that navigate mid-session.
function classifyTabForSwitch(tabId, url, state) {
  // Pinned / marked tab IDs take precedence
  if (tabId === state.musicTabId)   return 'music';
  if (tabId === state.lectureTabId) return 'lecture';
  if (tabId === state.movieTabId)   return 'movie';

  return classifyUrl(url, classifyConfig(state));
}

// send to content script — inject it first if missing, return null if tab is unreachable
async function safeSendMessage(tabId, message) {
  if (!tabId || typeof tabId !== 'number') return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_firstErr) {
    // content script missing — inject and retry once
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files:  ['content.js'],
      });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (_secondErr) {
      return null; // chrome://, PDF, or injection failed
    }
  } finally {
    void chrome.runtime.lastError;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markExtMuted(tabId, muted) {
  const state = await getState();
  const set = new Set(state.extMutedTabIds || []);
  if (muted) set.add(tabId); else set.delete(tabId);
  await setState({ extMutedTabIds: Array.from(set) });
}

async function controlTab(tabId, action, fadeAudio) {
  if (!tabId || typeof tabId !== 'number') return;
  if (action !== 'pause' && action !== 'play') return;

  // if we own a Layer 2 mute on this tab, undo it before trying to play
  if (action === 'play') {
    const preState = await getState();
    if ((preState.extMutedTabIds || []).includes(tabId)) {
      try { await chrome.tabs.update(tabId, { muted: false }); } catch { /* tab gone */ }
      await markExtMuted(tabId, false);
    }
  }

  // Layer 1: real pause/play via content.js
  const response = await safeSendMessage(tabId, { action, fadeAudio: !!fadeAudio });

  await wait(action === 'pause' ? 300 : 200);

  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; } // tab closed mid-flight

  const contentConfirmed = response && response.handled && response.confirmed === true;
  // explicit false = content script found the element but it's still in the wrong state
  // stronger signal than tab.audible (which can drop during silence between tracks)
  const contentExplicitlyFailed = response && response.handled && response.confirmed === false;

  if (action === 'pause') {
    if (contentConfirmed || (tab.audible === false && !contentExplicitlyFailed)) return;
    // Layer 1 failed or unconfirmed — mute the tab as fallback
    try { await chrome.tabs.update(tabId, { muted: true }); } catch { return; }
    await markExtMuted(tabId, true);
  } else {
    // Layer 2 for play = just unmute (done above). chrome.tabs has no play() API.
    // If Layer 1 also failed, retry once in case the SPA player wasn't ready yet.
    if (!contentConfirmed && tab.audible === false) {
      await safeSendMessage(tabId, { action: 'play', fadeAudio: !!fadeAudio });
    }
  }
}

// Pauses every open tab classified into `category` (not just the tracked one) —
// catches tabs that were already open before the extension noticed them.
// Skips `exceptTabId` (the tab that just "won" and should keep playing).
// Only bothers acting on tabs that are actually audible, to avoid pointless
// content-script injections on silent/paused tabs.
// `knownState`, when the caller already has a fresh state snapshot (e.g. a
// multi-category loop in activateCategoryTab), skips a redundant storage read.
async function pauseCategory(category, exceptTabId, fadeAudio, knownState) {
  const state = knownState || await getState();
  const config = classifyConfig(state);
  const tabIdField = CATEGORY_TAB_FIELD[category];
  const urlField   = CATEGORY_URL_FIELD[category];

  let allTabs;
  try { allTabs = await chrome.tabs.query({}); } catch { return; }

  let trackedFound = !!state[tabIdField];

  for (const t of allTabs) {
    if (!t.url || t.id === exceptTabId) continue;
    const isTracked  = t.id === state[tabIdField];
    const classified = isTracked || classifyUrl(t.url, config) === category;
    if (!classified) continue;

    if (isTracked || t.audible !== false) {
      await controlTab(t.id, 'pause', fadeAudio);
    }
    if (!trackedFound) {
      trackedFound = true;
      await setState({ [tabIdField]: t.id, [urlField]: t.url });
    }
  }
}

async function updateBadge(activeTabId, state) {
  const { musicTabId, lectureTabId, movieTabId, settings, userManuallyStopped } = state;

  // Pending-conflict indicator takes priority over all other badge states.
  // Show "!" in amber whenever any category has an unresolved conflict, so the user
  // always knows something needs attention — even without opening the popup or relying
  // on a system notification being seen (which requires a permission the user may deny).
  if (Object.keys(state.pendingConflicts || {}).length > 0) {
    try {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
    } catch (_err) { /* ignore */ }
    return;
  }

  let text = '', color = '#555555';

  if (settings.smartMode) {
    let role = 'neutral';
    if (activeTabId) {
      try {
        const tab = await chrome.tabs.get(activeTabId);
        role = classifyTabForSwitch(activeTabId, tab.url, state);
      } catch { /* tab gone */ }
    }
    if (role === 'music')        { text = 'M'; color = '#1DB954'; }
    else if (role === 'lecture') { text = 'L'; color = '#4285F4'; }
    else if (role === 'movie')   { text = 'V'; color = '#E50914'; }
    else if (musicTabId || lectureTabId || movieTabId) {
      // On a neutral/work tab — music plays only if the feature is on AND the
      // user hasn't explicitly stopped it (shortcut/popup pause).
      const willPlay = settings.playMusicOnWorkTabs && !userManuallyStopped;
      text = willPlay ? 'M' : 'S';
      color = willPlay ? '#1DB954' : '#9C27B0';
    }
  } else {
    if (activeTabId === musicTabId)        { text = 'M'; color = '#1DB954'; }
    else if (activeTabId === lectureTabId) { text = 'L'; color = '#4285F4'; }
    else if (activeTabId === movieTabId)   { text = 'V'; color = '#E50914'; }
    else if (musicTabId && !settings.pauseBothWhenElsewhere && !userManuallyStopped) {
      text = 'M'; color = '#1DB954';
    }
  }

  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch (_err) { /* ignore */ }
}

function sendNotification(message) {
  try {
    chrome.notifications.create({
      type:    'basic',
      iconUrl: 'icons/icon48.png',
      title:   'Smart Media Tab Manager',
      message,
    });
  } catch (_err) { /* ignore */ }
}

// --- MediaManager core: one active tab per category, everything routed through here ---

// Activates `tabId` as the current tab for `category`, pausing EVERY tab in every
// OTHER category (e.g. switching to a movie pauses music and lecture)
// plus any leftover audible tab in its OWN category the caller didn't already resolve
// (belt-and-braces for the "3 music tabs open" case). Sends one descriptive notification
// summarizing what changed.
async function activateCategoryTab(category, tabId, url, fadeAudio) {
  const before = await getState();
  const updates = {
    [CATEGORY_TAB_FIELD[category]]: tabId,
    [CATEGORY_URL_FIELD[category]]: url,
    lastActiveCategory: category,
  };
  if (category === 'music') updates.userManuallyStopped = false;
  await setState(updates);

  const pausedLabels = [];
  for (const c of CATEGORIES) {
    const trackedId = before[CATEGORY_TAB_FIELD[c]];
    // pass `before` through — it's already a fresh snapshot from the top of this
    // function, so each iteration doesn't need its own chrome.storage.local.get roundtrip
    await pauseCategory(c, tabId, fadeAudio, before);
    if (trackedId && trackedId !== tabId) {
      const label = c === category ? labelFor(hostnameOf(before[CATEGORY_URL_FIELD[c]])) : CATEGORY_LABEL[c];
      pausedLabels.push(label);
    }
  }

  // Universal Audio Arbitration: Pause ANY OTHER tab in the browser that is currently producing audio
  let allTabs;
  try { allTabs = await chrome.tabs.query({}); } catch { allTabs = []; }
  for (const t of allTabs) {
    if (t.id !== tabId && isTabActuallyPlaying(t, before.extMutedTabIds)) {
      await controlTab(t.id, 'pause', fadeAudio);
    }
  }

  await controlTab(tabId, 'play', fadeAudio);

  const fresh = await getState();
  if (fresh.settings.notifyOnSwitch) {
    const site = labelFor(hostnameOf(url));
    const uniquePaused = Array.from(new Set(pausedLabels));
    const suffix = uniquePaused.length ? ` — Paused ${uniquePaused.join(', ')}` : '';
    sendNotification(`${CATEGORY_EMOJI[category]} ${CATEGORY_LABEL[category]}: Playing ${site}${suffix}`);
  }
  await updateBadge(tabId, fresh);
}

// Called whenever a tab classified as music/lecture/movie becomes active. Detects
// whether another tab of the SAME category is already audibly playing,
// and either auto-resolves it (remembered preference) or asks the user.
async function resolveCategoryActivation(category, tabId, url, hostname, state, fadeAudio) {
  let allTabs;
  try { allTabs = await chrome.tabs.query({}); } catch { allTabs = []; }
  const config = classifyConfig(state);

  // Use isTabActuallyPlaying so that a tab we layer-2-muted (extMutedTabIds) is
  // not treated as "really playing" — it's audible:true but silent by our own hand.
  const conflictTab = allTabs.find((t) => {
    if (t.id === tabId || !t.url) return false;
    if (!isTabActuallyPlaying(t, state.extMutedTabIds)) return false;
    const isTracked = t.id === state[CATEGORY_TAB_FIELD[category]];
    return isTracked || classifyUrl(t.url, config) === category;
  });

  if (!conflictTab) {
    await activateCategoryTab(category, tabId, url, fadeAudio);
    return;
  }

  // If a conflict prompt is already outstanding for this category (a third tab
  // appeared while the user hasn't responded yet), silently pause the new tab
  // without spawning a second notification. Only one conflict prompt per category
  // is shown at a time.
  const existingPending = (state.pendingConflicts || {})[category];
  if (existingPending) {
    await controlTab(tabId, 'pause', fadeAudio);
    if (DEBUG_LOGGING) console.log(`[SMTM] Third ${category} tab silently paused — conflict already pending`);
    return;
  }

  const conflictHostname = hostnameOf(conflictTab.url);
  const preferred = (state.settings.categoryPreference || {})[category];

  if (preferred && preferred === hostname) {
    // remembered choice already favors the newly activated site — switch, no need to ask
    await activateCategoryTab(category, tabId, url, fadeAudio);
    return;
  }
  if (preferred && preferred === conflictHostname) {
    // remembered choice favors what's already playing — keep it, quietly pause the new one
    await controlTab(tabId, 'pause', fadeAudio);
    return;
  }

  await askUserToChooseSource(
    category,
    { tabId, url, hostname },
    { tabId: conflictTab.id, url: conflictTab.url, hostname: conflictHostname },
    fadeAudio
  );
}

// "Which <category> source would you like to continue?" Safe default while waiting
// (or if the user never responds) is to pause the NEW tab and keep the one already
// playing — never let both play. Stored in chrome.storage (not memory only) so a
// service-worker restart or the popup can still resolve it correctly.
async function askUserToChooseSource(category, candidate, existing, fadeAudio) {
  await controlTab(candidate.tabId, 'pause', fadeAudio);

  const notificationId = `smtm-conflict-${category}-${Date.now()}`;
  const state = await getState();
  const pendingConflicts = { ...(state.pendingConflicts || {}) };
  pendingConflicts[category] = {
    notificationId,
    category,
    candidate,
    existing,
    fadeAudio: !!fadeAudio,
    createdAt: Date.now(),
  };
  await setState({ pendingConflicts });

  const label = CATEGORY_LABEL[category];
  try {
    chrome.notifications.create(notificationId, {
      type:    'basic',
      iconUrl: 'icons/icon48.png',
      title:   `${CATEGORY_EMOJI[category]} You already have ${label.toLowerCase()} playing`,
      message: `${labelFor(existing.hostname)} is playing. Which ${label.toLowerCase()} source do you want to continue?`,
      buttons: [
        { title: `▶ Continue ${labelFor(candidate.hostname)}` },
        { title: `▶ Continue ${labelFor(existing.hostname)}` },
      ],
      requireInteraction: true,
    });
  } catch (err) {
    console.warn('[SMTM] Could not create conflict notification:', err.message);
  }

  // 15s auto-timeout: if the user never responds, default safely to keeping
  // whatever was already playing (never leave a conflict prompt open forever).
  clearConflictTimer(category);
  try {
    chrome.alarms.create(`conflict_timeout_${category}`, { delayInMinutes: 0.25 });
  } catch { /* fallback to setTimeout below */ }
  const timeoutId = setTimeout(async () => {
    _conflictTimeoutTimers.delete(category);
    const fresh = await getState();
    const stillPending = (fresh.pendingConflicts || {})[category];
    if (!stillPending || stillPending.notificationId !== notificationId) return; // already resolved
    await settleConflict(stillPending, 'existing');
    try { chrome.notifications.clear(notificationId); } catch { /* ignore */ }
  }, CONFLICT_TIMEOUT_MS);
  _conflictTimeoutTimers.set(category, timeoutId);
}

function clearConflictTimer(category) {
  const timeoutId = _conflictTimeoutTimers.get(category);
  if (timeoutId != null) {
    clearTimeout(timeoutId);
    _conflictTimeoutTimers.delete(category);
  }
  try {
    chrome.alarms.clear(`conflict_timeout_${category}`);
  } catch { /* ignore */ }
}

// choice: 'candidate' (the newly opened tab) or 'existing' (what was already playing)
async function settleConflict(entry, choice) {
  const { category, candidate, existing, fadeAudio } = entry;
  clearConflictTimer(category);
  const state = await getState();
  const pendingConflicts = { ...(state.pendingConflicts || {}) };
  delete pendingConflicts[category];
  const categoryPreference = { ...(state.settings.categoryPreference || {}) };

  if (choice === 'candidate') {
    categoryPreference[category] = candidate.hostname;
    await setState({ pendingConflicts, settings: { ...state.settings, categoryPreference } });
    await activateCategoryTab(category, candidate.tabId, candidate.url, fadeAudio);
  } else {
    categoryPreference[category] = existing.hostname;
    const updates = {
      pendingConflicts,
      settings: { ...state.settings, categoryPreference },
      [CATEGORY_TAB_FIELD[category]]: existing.tabId,
      [CATEGORY_URL_FIELD[category]]: existing.url,
    };
    if (category === 'music') updates.userManuallyStopped = false;
    await setState(updates);
    let existingTab;
    try { existingTab = await chrome.tabs.get(existing.tabId); } catch { existingTab = null; }
    if (existingTab) await controlTab(existing.tabId, 'play', fadeAudio);
    const fresh = await getState();
    if (fresh.settings.notifyOnSwitch) {
      sendNotification(`${CATEGORY_EMOJI[category]} Kept ${labelFor(existing.hostname)} playing — ${labelFor(candidate.hostname)} paused.`);
    }
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    await updateBadge(activeTab ? activeTab.id : null, fresh);
  }
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  const state = await getState();
  const entry = Object.values(state.pendingConflicts || {}).find((e) => e && e.notificationId === notificationId);
  if (!entry) return;
  await settleConflict(entry, buttonIndex === 0 ? 'candidate' : 'existing');
  try { chrome.notifications.clear(notificationId); } catch { /* ignore */ }
});

chrome.notifications.onClosed.addListener(async (notificationId) => {
  const state = await getState();
  const pendingConflicts = { ...(state.pendingConflicts || {}) };
  const category = Object.keys(pendingConflicts).find((k) => pendingConflicts[k] && pendingConflicts[k].notificationId === notificationId);
  if (category) {
    clearConflictTimer(category);
    delete pendingConflicts[category];
    await setState({ pendingConflicts });
    const fresh = await getState();
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    await updateBadge(activeTab ? activeTab.id : null, fresh);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm && alarm.name && alarm.name.startsWith('conflict_timeout_')) {
    const category = alarm.name.replace('conflict_timeout_', '');
    const state = await getState();
    const entry = (state.pendingConflicts || {})[category];
    if (entry) {
      await settleConflict(entry, 'existing');
      try { chrome.notifications.clear(entry.notificationId); } catch { /* ignore */ }
    }
  }
});

async function handleManualSwitch(activeTabId, activeWindowId, state) {
  const { musicTabId, lectureTabId, movieTabId, settings } = state;
  if (!musicTabId && !lectureTabId && !movieTabId) return;

  const isMusic   = activeTabId === musicTabId;
  const isLecture = activeTabId === lectureTabId;
  const isMovie   = activeTabId === movieTabId;

  if (isMusic) {
    // switching to music = user wants to listen, clear the manual-stop flag
    await setState({ userManuallyStopped: false });
    if (lectureTabId && lectureTabId !== musicTabId) await controlTab(lectureTabId, 'pause', settings.fadeAudio);
    if (movieTabId && movieTabId !== musicTabId)     await controlTab(movieTabId,   'pause', settings.fadeAudio);
    // Pause any other audible background tab
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    for (const t of allTabs) {
      if (t.id !== activeTabId && isTabActuallyPlaying(t, state.extMutedTabIds)) {
        await controlTab(t.id, 'pause', settings.fadeAudio);
      }
    }
    await controlTab(musicTabId,   'play',  settings.fadeAudio);
    if (settings.notifyOnSwitch) sendNotification('🎵 Music resumed, others paused.');
  } else if (isLecture) {
    if (musicTabId && musicTabId !== lectureTabId) await controlTab(musicTabId, 'pause', settings.fadeAudio);
    if (movieTabId && movieTabId !== lectureTabId) await controlTab(movieTabId, 'pause', settings.fadeAudio);
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    for (const t of allTabs) {
      if (t.id !== activeTabId && isTabActuallyPlaying(t, state.extMutedTabIds)) {
        await controlTab(t.id, 'pause', settings.fadeAudio);
      }
    }
    await controlTab(lectureTabId, 'play',  settings.fadeAudio);
    if (settings.notifyOnSwitch) sendNotification('🎓 Lecture resumed, others paused.');
  } else if (isMovie) {
    if (musicTabId && musicTabId !== movieTabId)     await controlTab(musicTabId,   'pause', settings.fadeAudio);
    if (lectureTabId && lectureTabId !== movieTabId) await controlTab(lectureTabId, 'pause', settings.fadeAudio);
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    for (const t of allTabs) {
      if (t.id !== activeTabId && isTabActuallyPlaying(t, state.extMutedTabIds)) {
        await controlTab(t.id, 'pause', settings.fadeAudio);
      }
    }
    await controlTab(movieTabId,   'play',  settings.fadeAudio);
    if (settings.notifyOnSwitch) sendNotification('🎬 Movie/TV resumed, others paused.');
  } else {
    // Switched to a neutral/work tab or another window:
    // CORE RULE: Lectures and Movies must NEVER play in the background!
    if (lectureTabId) await controlTab(lectureTabId, 'pause', settings.fadeAudio);
    if (movieTabId)   await controlTab(movieTabId,   'pause', settings.fadeAudio);

    // Music can continue playing in the background unless pauseBothWhenElsewhere is turned on
    if (settings.pauseBothWhenElsewhere) {
      if (musicTabId) {
        await controlTab(musicTabId, 'pause', settings.fadeAudio);
        if (settings.notifyOnSwitch) sendNotification('All media paused.');
      }
    } else {
      let activeTabObj = null;
      try { activeTabObj = await chrome.tabs.get(activeTabId); } catch { /* ignore */ }
      const activePlaying = activeTabObj && isTabActuallyPlaying(activeTabObj, state.extMutedTabIds);
      if (activePlaying) {
        if (musicTabId) await controlTab(musicTabId, 'pause', settings.fadeAudio);
      } else if (musicTabId && !state.userManuallyStopped) {
        await controlTab(musicTabId, 'play', settings.fadeAudio);
      }
    }
  }

  await updateBadge(activeTabId, await getState());
}

// smart mode core: routes activation through the MediaManager (activateCategoryTab /
// resolveCategoryActivation) so multiple tabs of the same category never both play,
// and activating any one of music/lecture/movie pauses the other two categories.
async function handleSmartSwitch(activeTabId, activeWindowId, state) {
  let tab;
  try { tab = await chrome.tabs.get(activeTabId); } catch { return; }

  const { settings } = state;
  const role = classifyTabForSwitch(activeTabId, tab.url, state);

  if (CATEGORIES.includes(role)) {
    const hostname = hostnameOf(tab.url);
    await resolveCategoryActivation(role, activeTabId, tab.url, hostname, state, settings.fadeAudio);
  } else {
    // Neutral/work tab (GitHub, docs, etc.)
    // CORE RULE: Lectures and Movies must NEVER play in the background unattended!
    await pauseCategory('lecture', null, settings.fadeAudio);
    await pauseCategory('movie', null, settings.fadeAudio);

    let musicTabId = state.musicTabId;
    if (!musicTabId) {
      const allTabs = await chrome.tabs.query({}).catch(() => []);
      const config = classifyConfig(state);
      const foundMusicTab = allTabs.find((t) => t.url && classifyUrl(t.url, config) === 'music');
      if (foundMusicTab) {
        musicTabId = foundMusicTab.id;
        await setState({ musicTabId: foundMusicTab.id, musicUrl: foundMusicTab.url });
      }
    }

    // Strict rule: Pause any other background tab that is actually playing audio
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    for (const t of allTabs) {
      if (t.id !== activeTabId && t.id !== musicTabId && isTabActuallyPlaying(t, state.extMutedTabIds)) {
        await controlTab(t.id, 'pause', settings.fadeAudio);
      }
    }

    // If active tab itself is producing audio, pause background music so they don't play together
    const activeIsPlaying = isTabActuallyPlaying(tab, state.extMutedTabIds);
    if (activeIsPlaying) {
      if (musicTabId) await controlTab(musicTabId, 'pause', settings.fadeAudio);
    } else if (settings.playMusicOnWorkTabs && musicTabId && !state.userManuallyStopped) {
      await controlTab(musicTabId, 'play', settings.fadeAudio);
    } else if (!settings.playMusicOnWorkTabs) {
      if (musicTabId) {
        await controlTab(musicTabId, 'pause', settings.fadeAudio);
      }
    }
  }

  await updateBadge(activeTabId, await getState());
}

// fires when browser loses focus entirely (Alt+Tab, minimise, lock screen)
async function handleAppBlur() {
  const state = await getState();
  if (!state.settings.smartMode || !state.settings.playMusicOnAppSwitch) return;
  if (state.userManuallyStopped) return;

  let musicTabId = state.musicTabId;
  if (!musicTabId) {
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    const config = classifyConfig(state);
    const foundMusicTab = allTabs.find((t) => t.url && classifyUrl(t.url, config) === 'music');
    if (foundMusicTab) {
      musicTabId = foundMusicTab.id;
      await setState({ musicTabId: foundMusicTab.id, musicUrl: foundMusicTab.url });
    }
  }

  if (!musicTabId) return;
  if (checkCooldown(musicTabId, 'appBlur')) return;

  await pauseCategory('lecture', musicTabId, state.settings.fadeAudio);
  await pauseCategory('movie', musicTabId, state.settings.fadeAudio);
  const allTabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of allTabs) {
    if (t.id !== musicTabId && isTabActuallyPlaying(t, state.extMutedTabIds)) {
      await controlTab(t.id, 'pause', state.settings.fadeAudio);
    }
  }
  await controlTab(musicTabId, 'play', state.settings.fadeAudio);

  if (state.settings.notifyOnSwitch) {
    sendNotification('Browser is in the background — music is playing.');
  }
}

// Shared helper: switch focus/playback between the two pinned tabs, or (when
// neither is currently active) jump to whichever one is pinned and make sure
// its counterpart is paused. Used by the "toggle-mode" keyboard shortcut.
async function switchBetweenPinnedTabs(musicTabId, lectureTabId, settings, source) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) return;

  const state = await getState();
  if (state.movieTabId) {
    await controlTab(state.movieTabId, 'pause', settings.fadeAudio);
  }

  if (activeTab.id === musicTabId) {
    if (!lectureTabId) return;
    setExplicitCooldown(musicTabId,   source, 'switchAway');
    setExplicitCooldown(lectureTabId, source, 'switchTo');
    await controlTab(musicTabId,   'pause', settings.fadeAudio);
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    for (const t of allTabs) {
      if (t.id !== lectureTabId && isTabActuallyPlaying(t, state.extMutedTabIds)) {
        await controlTab(t.id, 'pause', settings.fadeAudio);
      }
    }
    await controlTab(lectureTabId, 'play',  settings.fadeAudio);
    try {
      const targetTab = await chrome.tabs.get(lectureTabId);
      await chrome.tabs.update(lectureTabId, { active: true });
      if (targetTab && targetTab.windowId) await chrome.windows.update(targetTab.windowId, { focused: true });
    } catch { /* ignore */ }
    await updateBadge(lectureTabId, await getState());
    return;
  }

  if (activeTab.id === lectureTabId) {
    if (!musicTabId) return;
    setExplicitCooldown(lectureTabId, source, 'switchAway');
    setExplicitCooldown(musicTabId,   source, 'switchTo');
    await setState({ userManuallyStopped: false });
    await controlTab(lectureTabId, 'pause', settings.fadeAudio);
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    for (const t of allTabs) {
      if (t.id !== musicTabId && isTabActuallyPlaying(t, state.extMutedTabIds)) {
        await controlTab(t.id, 'pause', settings.fadeAudio);
      }
    }
    await controlTab(musicTabId,   'play',  settings.fadeAudio);
    try {
      const targetTab = await chrome.tabs.get(musicTabId);
      await chrome.tabs.update(musicTabId, { active: true });
      if (targetTab && targetTab.windowId) await chrome.windows.update(targetTab.windowId, { focused: true });
    } catch { /* ignore */ }
    await updateBadge(musicTabId, await getState());
    return;
  }

  // Neither pinned tab is active — jump to whichever one is pinned (lecture
  // takes priority) and make sure the OTHER pinned tab is paused.
  const targetId = lectureTabId || musicTabId;
  if (!targetId) return;

  setExplicitCooldown(targetId, source, 'switchTo');
  if (targetId === lectureTabId && musicTabId) {
    setExplicitCooldown(musicTabId, source, 'switchAway');
    await controlTab(musicTabId, 'pause', settings.fadeAudio);
  } else if (targetId === musicTabId && lectureTabId) {
    setExplicitCooldown(lectureTabId, source, 'switchAway');
    await controlTab(lectureTabId, 'pause', settings.fadeAudio);
  }

  if (targetId === musicTabId) {
    await setState({ userManuallyStopped: false });
  }

  const allTabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of allTabs) {
    if (t.id !== targetId && isTabActuallyPlaying(t, state.extMutedTabIds)) {
      await controlTab(t.id, 'pause', settings.fadeAudio);
    }
  }

  await controlTab(targetId, 'play', settings.fadeAudio);
  try {
    const targetTab = await chrome.tabs.get(targetId);
    await chrome.tabs.update(targetId, { active: true });
    if (targetTab && targetTab.windowId) await chrome.windows.update(targetTab.windowId, { focused: true });
  } catch { /* ignore */ }
  await updateBadge(targetId, await getState());
}

async function handleTabSwitch(activeTabId, activeWindowId) {
  // onActivated and onFocusChanged can both fire for the same physical
  // switch to the same tab — collapse them into a single handled event.
  const now = Date.now();
  if (
    _lastHandledSwitch.tabId === activeTabId &&
    now - _lastHandledSwitch.time < DUPLICATE_SWITCH_MS
  ) {
    return;
  }
  _lastHandledSwitch = { tabId: activeTabId, time: now };

  if (checkCooldown(activeTabId, 'tabSwitch')) return;

  const state = await getState();
  if (state.settings.smartMode) {
    await handleSmartSwitch(activeTabId, activeWindowId, state);
  } else {
    await handleManualSwitch(activeTabId, activeWindowId, state);
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await handleTabSwitch(tabId, windowId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await handleAppBlur();
    return;
  }
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeTab) await handleTabSwitch(activeTab.id, windowId);
  } catch { /* window closed between event and query */ }
});

// re-classify when a tab navigates (Spotify track change, new YouTube video, etc.)
//
// SPAs (Spotify, YouTube) can fire several url-changing onUpdated events within a
// few milliseconds of each other for what's really a single navigation (e.g. a
// query-param update immediately followed by the real path change). Without
// debouncing, each one independently reads state, re-classifies, and potentially
// calls activateCategoryTab — redundant work that all converges on the same
// final classification anyway. Coalesce bursts per-tab into a single classify
// pass, same behavior/outcome, fewer storage reads and content-script round trips.
const TAB_UPDATE_DEBOUNCE_MS = 200;
const _tabUpdateTimers = new Map(); // tabId -> timeoutId

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // ── URL change: re-classify the active tab after SPA navigation ──────────
  // Debounced so rapid query-param updates (YouTube autoplay-next, Spotify track
  // changes) don't each independently trigger a full classify+pause round trip.
  if (changeInfo.url) {
    const existing = _tabUpdateTimers.get(tabId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      _tabUpdateTimers.delete(tabId);
      const state = await getState();

      // If a tracked tab navigated, keep its stored URL updated
      const urlUpdates = {};
      if (tabId === state.musicTabId && state.musicUrl !== changeInfo.url) {
        urlUpdates.musicUrl = changeInfo.url;
      }
      if (tabId === state.lectureTabId && state.lectureUrl !== changeInfo.url) {
        urlUpdates.lectureUrl = changeInfo.url;
      }
      if (tabId === state.movieTabId && state.movieUrl !== changeInfo.url) {
        urlUpdates.movieUrl = changeInfo.url;
      }
      if (Object.keys(urlUpdates).length > 0) {
        await setState(urlUpdates);
      }

      if (!state.settings.smartMode) return;
      if (checkCooldown(tabId, 'tabUpdated')) return;
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || activeTab.id !== tabId) return;
        await handleSmartSwitch(tabId, tab.windowId, state);
      } catch { /* ignore */ }
    }, TAB_UPDATE_DEBOUNCE_MS);

    _tabUpdateTimers.set(tabId, timer);
  }

  // ── Audible change: background-tab autoplay detection ────────────────────
  // onActivated / onFocusChanged only fire when the USER switches to a tab.
  // If two same-category tabs both autoplay in the background (e.g. two YouTube
  // tabs opening, or Spotify already playing then YouTube Music starts in a
  // background tab), nothing else catches them. This handler fires on ANY tab
  // becoming audible, regardless of which tab has focus.
  if (changeInfo.audible === true) {
    (async () => {
      try {
        const state = await getState();
        if (checkCooldown(tabId, 'tabAudible')) return;

        let liveTab;
        try { liveTab = await chrome.tabs.get(tabId); } catch { return; }

        let activeTab = null;
        try {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          activeTab = tab;
        } catch { /* ignore */ }

        const isActive = activeTab && activeTab.id === tabId;

        if (state.settings.smartMode) {
          const role = classifyTabForSwitch(tabId, liveTab.url, state);

          if (!isActive) {
            // Tab is in the background!
            if (role === 'music') {
              // Background music started:
              // If user is currently focused on an active lecture or movie tab, or active tab is playing sound, background music must NOT play over it!
              const activeRole = activeTab ? classifyTabForSwitch(activeTab.id, activeTab.url, state) : 'neutral';
              const activePlaying = activeTab && isTabActuallyPlaying(activeTab, state.extMutedTabIds);
              if (
                activeRole === 'lecture' ||
                activeRole === 'movie' ||
                activePlaying ||
                (activeRole === 'neutral' && (!state.settings.playMusicOnWorkTabs || state.userManuallyStopped))
              ) {
                await controlTab(tabId, 'pause', state.settings.fadeAudio);
                return;
              }
              const hostname = hostnameOf(liveTab.url);
              await resolveCategoryActivation(role, tabId, liveTab.url, hostname, state, state.settings.fadeAudio);
            } else {
              // Strict rule: Lectures, Movies, and ANY non-music tabs must NEVER play in the background unattended.
              await controlTab(tabId, 'pause', state.settings.fadeAudio);
              return;
            }
          } else {
            // Active tab became audible
            if (CATEGORIES.includes(role)) {
              const hostname = hostnameOf(liveTab.url);
              await resolveCategoryActivation(role, tabId, liveTab.url, hostname, state, state.settings.fadeAudio);
            } else {
              // Active neutral tab became audible — pause background music so both don't play
              if (state.musicTabId && tabId !== state.musicTabId) {
                await controlTab(state.musicTabId, 'pause', state.settings.fadeAudio);
              }
            }
          }
        } else {
          // Manual Mode
          const { musicTabId, lectureTabId, movieTabId, settings } = state;
          if (!isActive) {
            if (tabId === lectureTabId || tabId === movieTabId) {
              await controlTab(tabId, 'pause', settings.fadeAudio);
              return;
            } else if (tabId === musicTabId) {
              const activePlaying = activeTab && isTabActuallyPlaying(activeTab, state.extMutedTabIds);
              if (
                (activeTab && (activeTab.id === lectureTabId || activeTab.id === movieTabId)) ||
                activePlaying ||
                settings.pauseBothWhenElsewhere ||
                state.userManuallyStopped
              ) {
                await controlTab(tabId, 'pause', settings.fadeAudio);
                return;
              }
            } else {
              // Any other background tab
              await controlTab(tabId, 'pause', settings.fadeAudio);
              return;
            }
          } else {
            // Active manual tab became audible — ensure others are paused
            if (tabId === musicTabId) {
              if (lectureTabId) await controlTab(lectureTabId, 'pause', settings.fadeAudio);
              if (movieTabId)   await controlTab(movieTabId,   'pause', settings.fadeAudio);
            } else if (tabId === lectureTabId) {
              if (musicTabId) await controlTab(musicTabId, 'pause', settings.fadeAudio);
              if (movieTabId) await controlTab(movieTabId, 'pause', settings.fadeAudio);
            } else if (tabId === movieTabId) {
              if (musicTabId)   await controlTab(musicTabId,   'pause', settings.fadeAudio);
              if (lectureTabId) await controlTab(lectureTabId, 'pause', settings.fadeAudio);
            } else {
              // Active neutral tab became audible — pause music
              if (musicTabId) await controlTab(musicTabId, 'pause', settings.fadeAudio);
            }
          }
        }
      } catch { /* ignore — tab may have closed between event and handler */ }
    })();
  }

  // ── Silence on active neutral tab: resume background music ────────────────
  if (changeInfo.audible === false) {
    (async () => {
      try {
        const state = await getState();
        if (state.userManuallyStopped || !state.musicTabId || tabId === state.musicTabId) return;

        let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
        if (!activeTab || activeTab.id !== tabId) return; // only care if the ACTIVE tab went silent

        const role = classifyTabForSwitch(tabId, activeTab.url, state);
        if (role !== 'neutral') return; // only resume on neutral/work tabs

        const shouldResume = state.settings.smartMode
          ? state.settings.playMusicOnWorkTabs
          : !state.settings.pauseBothWhenElsewhere;

        if (shouldResume) {
          const allTabs = await chrome.tabs.query({}).catch(() => []);
          const anyOtherAudible = allTabs.some((t) => t.id !== state.musicTabId && isTabActuallyPlaying(t, state.extMutedTabIds));
          if (!anyOtherAudible) {
            await controlTab(state.musicTabId, 'play', state.settings.fadeAudio);
            await updateBadge(tabId, await getState());
          }
        }
      } catch { /* ignore */ }
    })();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state   = await getState();
  const updates = {};
  if (tabId === state.musicTabId)   { updates.musicTabId = null;   updates.musicUrl = null; updates.userManuallyStopped = false; }
  if (tabId === state.lectureTabId) { updates.lectureTabId = null; updates.lectureUrl = null; }
  if (tabId === state.movieTabId)   { updates.movieTabId = null;   updates.movieUrl = null;   }
  if ((state.extMutedTabIds || []).includes(tabId)) {
    updates.extMutedTabIds = state.extMutedTabIds.filter((id) => id !== tabId);
  }
  // Cancel any pending conflict prompt that referenced the tab that just closed —
  // otherwise its notification buttons would try to act on a dead tab.
  const pendingConflicts = { ...(state.pendingConflicts || {}) };
  let conflictsChanged = false;
  for (const [cat, entry] of Object.entries(pendingConflicts)) {
    if (entry && (entry.candidate.tabId === tabId || entry.existing.tabId === tabId)) {
      clearConflictTimer(cat);
      try { chrome.notifications.clear(entry.notificationId); } catch { /* ignore */ }
      delete pendingConflicts[cat];
      conflictsChanged = true;
    }
  }
  if (conflictsChanged) updates.pendingConflicts = pendingConflicts;

  if (Object.keys(updates).length > 0) {
    await setState(updates);
    // Recalculate the badge rather than blindly clearing it. If this tab was
    // involved in a pending conflict, clearing the conflict should switch the
    // badge from '!' back to whatever the current active-tab state actually is
    // (M / L / V / S / blank), not leave it blank unconditionally.
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await updateBadge(activeTab ? activeTab.id : null, await getState());
    } catch { try { chrome.action.setBadgeText({ text: '' }); } catch { /* ignore */ } }
  }
  // Clean up stale cooldown entries.
  _explicitCooldown.delete(tabId);
  if (_lastHandledSwitch.tabId === tabId) _lastHandledSwitch = { tabId: null, time: 0 };
  // Cancel any pending debounced onUpdated classification for this tab — it's
  // gone, so there's nothing left to classify once the timer fires.
  const pendingUpdateTimer = _tabUpdateTimers.get(tabId);
  if (pendingUpdateTimer) {
    clearTimeout(pendingUpdateTimer);
    _tabUpdateTimers.delete(tabId);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-mode') return;
  const state = await getState();
  const { musicTabId, lectureTabId, settings } = state;
  if (!musicTabId && !lectureTabId) return;
  try {
    await switchBetweenPinnedTabs(musicTabId, lectureTabId, settings, 'shortcut');
  } catch { /* tab gone */ }
});

function extractHostname(input) {
  if (!input) return null;
  let str = String(input).trim().toLowerCase();
  if (!str) return null;
  try {
    if (!str.includes('://')) {
      str = 'https://' + str;
    }
    const u = new URL(str);
    return u.hostname.replace(/^www\./, '');
  } catch {
    const raw = str.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split('#')[0].replace(/^www\./, '');
    return raw && /^[a-z0-9.-]+$/i.test(raw) ? raw : null;
  }
}

function sanitizeHostnameList(list) {
  if (!Array.isArray(list)) return null;
  const cleaned = list
    .map(extractHostname)
    .filter((h) => h && h.length > 0 && (h.includes('.') || h === 'localhost'));
  return Array.from(new Set(cleaned));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'setMusicTab': {
          const s = await getState();
          const host = extractHostname(message.url);
          const updates = { musicTabId: message.tabId, musicUrl: message.url, userManuallyStopped: false };
          if (s.lectureTabId === message.tabId) { updates.lectureTabId = null; updates.lectureUrl = null; }
          if (s.movieTabId === message.tabId)   { updates.movieTabId = null;   updates.movieUrl = null;   }
          if (host && (host.includes('.') || host === 'localhost')) {
            const isYt = host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
            if (!isYt) {
              if (!s.musicHostnames.includes(host)) updates.musicHostnames = [...s.musicHostnames, host];
              if (s.lectureHostnames.includes(host)) updates.lectureHostnames = s.lectureHostnames.filter((h) => h !== host);
              if (s.movieHostnames.includes(host)) updates.movieHostnames = s.movieHostnames.filter((h) => h !== host);
            }
          }
          await setState(updates);
          const [activeTabM] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
          if (activeTabM && activeTabM.id === message.tabId) {
            _lastHandledSwitch = { tabId: null, time: 0 };
            await handleTabSwitch(message.tabId, activeTabM.windowId);
          } else {
            await updateBadge(message.tabId, await getState());
          }
          sendResponse({ success: true });
          break;
        }
        case 'setLectureTab': {
          const s = await getState();
          const host = extractHostname(message.url);
          const updates = { lectureTabId: message.tabId, lectureUrl: message.url };
          if (s.musicTabId === message.tabId) { updates.musicTabId = null; updates.musicUrl = null; }
          if (s.movieTabId === message.tabId) { updates.movieTabId = null; updates.movieUrl = null; }
          if (host && (host.includes('.') || host === 'localhost')) {
            const isYt = host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
            if (!isYt) {
              if (!s.lectureHostnames.includes(host)) updates.lectureHostnames = [...s.lectureHostnames, host];
              if (s.musicHostnames.includes(host)) updates.musicHostnames = s.musicHostnames.filter((h) => h !== host);
              if (s.movieHostnames.includes(host)) updates.movieHostnames = s.movieHostnames.filter((h) => h !== host);
            }
          }
          await setState(updates);
          const [activeTabL] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
          if (activeTabL && activeTabL.id === message.tabId) {
            _lastHandledSwitch = { tabId: null, time: 0 };
            await handleTabSwitch(message.tabId, activeTabL.windowId);
          } else {
            await updateBadge(message.tabId, await getState());
          }
          sendResponse({ success: true });
          break;
        }
        case 'setMovieTab': {
          const s = await getState();
          const host = extractHostname(message.url);
          const updates = { movieTabId: message.tabId, movieUrl: message.url };
          if (s.musicTabId === message.tabId)   { updates.musicTabId = null;   updates.musicUrl = null;   }
          if (s.lectureTabId === message.tabId) { updates.lectureTabId = null; updates.lectureUrl = null; }
          if (host && (host.includes('.') || host === 'localhost')) {
            const isYt = host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
            if (!isYt) {
              if (!s.movieHostnames.includes(host)) updates.movieHostnames = [...s.movieHostnames, host];
              if (s.musicHostnames.includes(host)) updates.musicHostnames = s.musicHostnames.filter((h) => h !== host);
              if (s.lectureHostnames.includes(host)) updates.lectureHostnames = s.lectureHostnames.filter((h) => h !== host);
            }
          }
          await setState(updates);
          const [activeTabV] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
          if (activeTabV && activeTabV.id === message.tabId) {
            _lastHandledSwitch = { tabId: null, time: 0 };
            await handleTabSwitch(message.tabId, activeTabV.windowId);
          } else {
            await updateBadge(message.tabId, await getState());
          }
          sendResponse({ success: true });
          break;
        }
        case 'clearBoth': {
          const sClear = await getState();
          for (const mutedId of (sClear.extMutedTabIds || [])) {
            try { await chrome.tabs.update(mutedId, { muted: false }); } catch { /* tab gone */ }
          }
          await setState({
            musicTabId: null, lectureTabId: null, movieTabId: null,
            musicUrl: null,   lectureUrl: null,   movieUrl: null,
            extMutedTabIds: [],
            userManuallyStopped: false,
          });
          try { chrome.action.setBadgeText({ text: '' }); } catch { /* ignore */ }
          sendResponse({ success: true });
          break;
        }
        case 'getState': {
          const fullState = await getState();
          sendResponse({
            success: true,
            state: {
              ...fullState,
              // include defaults so Options page can do reset without re-declaring them
              defaultMusicHostnames:   DEFAULT_MUSIC_HOSTNAMES,
              defaultLectureHostnames: DEFAULT_LECTURE_HOSTNAMES,
              defaultMovieHostnames:   DEFAULT_MOVIE_HOSTNAMES,
            },
          });
          break;
        }
        case 'classifyUrl': {
          const s = await getState();
          const role = message.tabId
            ? classifyTabForSwitch(message.tabId, message.url, s)
            : classifyUrl(message.url, classifyConfig(s));
          sendResponse({ success: true, role });
          break;
        }
        case 'resolveYoutubeAmbiguity': {
          const role = message.role; // 'music' | 'lecture' | 'movie'
          if (!CATEGORIES.includes(role)) {
            sendResponse({ success: false, error: 'Invalid role' });
            break;
          }
          const sYt = await getState();
          const updates = {
            [CATEGORY_TAB_FIELD[role]]: message.tabId,
            [CATEGORY_URL_FIELD[role]]: message.url,
            settings: { ...sYt.settings, youtubeLastChoice: role },
          };
          if (role === 'music') {
            updates.userManuallyStopped = false;
            if (sYt.lectureTabId === message.tabId) { updates.lectureTabId = null; updates.lectureUrl = null; }
            if (sYt.movieTabId === message.tabId)   { updates.movieTabId = null;   updates.movieUrl = null;   }
          } else if (role === 'lecture') {
            if (sYt.musicTabId === message.tabId) { updates.musicTabId = null; updates.musicUrl = null; }
            if (sYt.movieTabId === message.tabId) { updates.movieTabId = null; updates.movieUrl = null; }
          } else if (role === 'movie') {
            if (sYt.musicTabId === message.tabId)   { updates.musicTabId = null;   updates.musicUrl = null;   }
            if (sYt.lectureTabId === message.tabId) { updates.lectureTabId = null; updates.lectureUrl = null; }
          }
          await setState(updates);
          const hostname = hostnameOf(message.url) || 'youtube.com';
          await resolveCategoryActivation(role, message.tabId, message.url, hostname, await getState(), sYt.settings.fadeAudio);
          sendResponse({ success: true });
          break;
        }
        case 'resolveConflict': {
          const category = message.category;
          const s = await getState();
          const entry = (s.pendingConflicts || {})[category];
          if (!entry) { sendResponse({ success: false, error: 'No pending conflict for this category' }); break; }
          await settleConflict(entry, message.choice === 'candidate' ? 'candidate' : 'existing');
          try { chrome.notifications.clear(entry.notificationId); } catch { /* ignore */ }
          sendResponse({ success: true });
          break;
        }
        case 'saveOptions': {
          const patch = {};
          const current = await getState();
          if (message.settings && typeof message.settings === 'object') {
            patch.settings = { ...current.settings, ...message.settings };
          }
          let cleanedMusic   = sanitizeHostnameList(message.musicHostnames);
          let cleanedLecture = sanitizeHostnameList(message.lectureHostnames);
          let cleanedMovie   = sanitizeHostnameList(message.movieHostnames);

          if (cleanedMusic !== null) {
            const musicSet = new Set(cleanedMusic);
            if (cleanedLecture !== null) cleanedLecture = cleanedLecture.filter((h) => !musicSet.has(h));
            if (cleanedMovie !== null)   cleanedMovie   = cleanedMovie.filter((h) => !musicSet.has(h));
            patch.musicHostnames = cleanedMusic;
          }
          if (cleanedLecture !== null) {
            const lectureSet = new Set(cleanedLecture);
            if (cleanedMovie !== null) cleanedMovie = cleanedMovie.filter((h) => !lectureSet.has(h));
            patch.lectureHostnames = cleanedLecture;
          }
          if (cleanedMovie !== null) {
            patch.movieHostnames = cleanedMovie;
          }
          if (message.forgetPreferences) {
            patch.settings = {
              ...(patch.settings || current.settings),
              categoryPreference: { music: null, lecture: null, movie: null },
              youtubeLastChoice: null,
            };
          }
          await setState(patch);
          const updated = await getState();
          sendResponse({
            success: true,
            state: {
              ...updated,
              defaultMusicHostnames:   DEFAULT_MUSIC_HOSTNAMES,
              defaultLectureHostnames: DEFAULT_LECTURE_HOSTNAMES,
              defaultMovieHostnames:   DEFAULT_MOVIE_HOSTNAMES,
            },
          });
          break;
        }
        // only care about manual pauses on music tabs — pausing a lecture shouldn't block auto-resume
        case 'userManualPause': {
          const sForPause = await getState();
          const senderTabId = _sender && _sender.tab && _sender.tab.id;
          const senderUrl   = _sender && _sender.tab && _sender.tab.url;

          // Ignore if sender is in cooldown (an extension action was sent to it recently)
          if (!senderTabId || checkCooldown(senderTabId, 'userManualPause')) {
            sendResponse({ success: true, ignored: true });
            break;
          }

          // A true user manual pause can only happen if the sender tab is active
          if (_sender.tab && _sender.tab.active === false) {
            sendResponse({ success: true, ignored: true });
            break;
          }

          let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
          if (activeTab && activeTab.id !== senderTabId) {
            sendResponse({ success: true, ignored: true });
            break;
          }

          const isMusicSender =
            senderTabId === sForPause.musicTabId ||
            classifyUrl(senderUrl, classifyConfig(sForPause)) === 'music';
          if (isMusicSender) {
            await setState({ userManuallyStopped: true });
          }
          sendResponse({ success: true });
          break;
        }
        case 'userManualPlay': {
          const sForPlay = await getState();
          const senderTabIdP = _sender && _sender.tab && _sender.tab.id;
          const senderUrlP   = _sender && _sender.tab && _sender.tab.url;
          const isMusicSenderP =
            senderTabIdP === sForPlay.musicTabId ||
            classifyUrl(senderUrlP, classifyConfig(sForPlay)) === 'music';
          if (isMusicSenderP) {
            await setState({ userManuallyStopped: false });
          }
          sendResponse({ success: true });
          break;
        }
        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (err) {
      console.error('[SMTM] Error handling message', message && message.action, err);
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true;
});
