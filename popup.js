// popup.js — popup UI

const musicTitle        = document.getElementById('music-title');
const lectureTitle      = document.getElementById('lecture-title');
const movieTitle        = document.getElementById('movie-title');
const setMusicBtn       = document.getElementById('set-music-btn');
const setLectureBtn     = document.getElementById('set-lecture-btn');
const setMovieBtn       = document.getElementById('set-movie-btn');
const clearBtn          = document.getElementById('clear-btn');
const optionsBtn        = document.getElementById('options-btn');
const statusDot         = document.getElementById('status-dot');
const statusText        = document.getElementById('status-text');
const warningEl         = document.getElementById('warning');
const warningText       = document.getElementById('warning-text');
const musicRow          = document.getElementById('music-row');
const lectureRow        = document.getElementById('lecture-row');
const movieRow          = document.getElementById('movie-row');
const smartPill         = document.getElementById('smart-pill');
const smartBanner       = document.getElementById('smart-banner');
const smartBannerText   = document.getElementById('smart-banner-text');
const currentTabRow     = document.getElementById('current-tab-row');
const currentTabRole    = document.getElementById('current-tab-role');
const musicAutoTag      = document.getElementById('music-auto-tag');
const lectureAutoTag    = document.getElementById('lecture-auto-tag');
const movieAutoTag      = document.getElementById('movie-auto-tag');
const sameDomainHint    = document.getElementById('same-domain-hint');
const sameDomainText    = document.getElementById('same-domain-hint-text');
const ytAmbiguityEl     = document.getElementById('yt-ambiguity');
const ytChoiceMusicBtn  = document.getElementById('yt-choice-music');
const ytChoiceLectureBtn = document.getElementById('yt-choice-lecture');
const ytChoiceMovieBtn  = document.getElementById('yt-choice-movie');
const musicAudibleTag   = document.getElementById('music-audible-tag');
const lectureAudibleTag = document.getElementById('lecture-audible-tag');
const movieAudibleTag   = document.getElementById('movie-audible-tag');
const conflictBanner    = document.getElementById('conflict-banner');
const conflictText      = document.getElementById('conflict-text');
const conflictChoiceA   = document.getElementById('conflict-choice-a');
const conflictChoiceB   = document.getElementById('conflict-choice-b');

const CATEGORY_LABEL = { music: 'Music', lecture: 'Lecture', movie: 'Movie/Show' };

function hostnameLabel(hostname) {
  return hostname ? hostname.replace(/^www\./, '') : 'Unknown';
}

function truncate(str, max = 26) {
  if (!str) return 'Not set';
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}

function showWarning(msg) {
  warningText.textContent = msg;
  warningEl.classList.remove('hidden');
}
function hideWarning() { warningEl.classList.add('hidden'); }

function showSameDomainHint(msg) {
  sameDomainText.textContent = msg;
  sameDomainHint.classList.remove('hidden');
}
function hideSameDomainHint() { sameDomainHint.classList.add('hidden'); }

function hostnameOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

// Single fetch per tracked tab, reused for existence + title + audible state,
// instead of three separate chrome.tabs.get round trips for the same tab.
// Also avoids the (rare) inconsistency of reading tab state at three
// slightly different points in time if it changes mid-render.
async function fetchTabInfo(tabId) {
  if (!tabId) return { exists: false, tab: null };
  try {
    const tab = await chrome.tabs.get(tabId);
    return { exists: true, tab };
  } catch {
    return { exists: false, tab: null };
  }
}

function isYoutubeWatchUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') return true;  // all youtu.be paths are watch links
    return (h === 'youtube.com' || h === 'm.youtube.com') && (u.pathname.startsWith('/watch') || u.pathname.startsWith('/live/'));
  } catch { return false; }
}

function showSmartModeUI(on) {
  smartPill.classList.toggle('hidden', !on);
  smartBanner.classList.toggle('hidden', !on);
  currentTabRow.classList.toggle('hidden', !on);
}

function setCurrentTabRoleUI(role, settings) {
  currentTabRole.className = 'current-tab-role ' + role;
  let label;
  if (role === 'music')        label = '🎵 Music site — music plays';
  else if (role === 'lecture') label = '📚 Lecture site — music pauses';
  else if (role === 'movie')   label = '🎬 Movie/TV site — music & lecture pause';
  else if (settings && settings.playMusicOnWorkTabs) label = '💻 Work tab — music plays';
  else                         label = 'Other tab';
  currentTabRole.textContent = label;
}

function hideConflictBanner() { conflictBanner.classList.add('hidden'); }

function showConflictBanner(category, entry) {
  const label = CATEGORY_LABEL[category] || category;
  conflictText.textContent =
    `${hostnameLabel(entry.existing.hostname)} is already playing ${label.toLowerCase()}. Which source do you want to continue?`;
  conflictChoiceA.textContent = `▶ Continue ${hostnameLabel(entry.candidate.hostname)}`;
  conflictChoiceB.textContent = `▶ Continue ${hostnameLabel(entry.existing.hostname)}`;
  conflictChoiceA.onclick = () => resolveConflict(category, 'candidate');
  conflictChoiceB.onclick = () => resolveConflict(category, 'existing');
  conflictBanner.classList.remove('hidden');
}

async function resolveConflict(category, choice) {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'resolveConflict', category, choice });
    if (!res || !res.success) showWarning('Failed to resolve the conflict.');
    else await loadAndRender();
  } catch {
    showWarning('Failed to resolve the conflict.');
  }
}

async function render(state) {
  const { musicTabId, lectureTabId, movieTabId, musicUrl, lectureUrl, movieUrl, settings, pendingConflicts } = state;
  const isSmartMode = settings && settings.smartMode;

  showSmartModeUI(isSmartMode);

  let activeTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab;
  } catch { /* popup opened during tab close or something weird */ }

  // One fetch per tracked tab — reused below for existence, title, and
  // audible state instead of three separate chrome.tabs.get calls each.
  const musicInfo   = await fetchTabInfo(musicTabId);
  const lectureInfo = await fetchTabInfo(lectureTabId);
  const movieInfo   = await fetchTabInfo(movieTabId);
  const musicValid   = musicInfo.exists;
  const lectureValid = lectureInfo.exists;
  const movieValid   = movieInfo.exists;

  // warn if a tracked tab got closed — report ALL that are gone, rather
  // than only ever surfacing the first one (music) and silently dropping
  // the others when they happen together.
  const closedNotices = [];
  if (musicTabId && !musicValid)     closedNotices.push('Music tab was closed.');
  if (lectureTabId && !lectureValid) closedNotices.push('Lecture tab was closed.');
  if (movieTabId && !movieValid)     closedNotices.push('Movie/TV tab was closed.');
  if (closedNotices.length > 0) {
    showWarning(`${closedNotices.join(' ')} Re-mark your tabs to resume.`);
  } else {
    hideWarning();
  }

  if (musicTabId && musicValid) {
    const tab = musicInfo.tab;
    musicTitle.textContent = truncate((tab && tab.title) || musicUrl || 'Tab set');
    musicAutoTag.classList.toggle('hidden', !isSmartMode);
  } else {
    musicTitle.textContent = isSmartMode ? 'Waiting for music tab\u2026' : 'Not set';
    musicAutoTag.classList.add('hidden');
  }

  if (lectureTabId && lectureValid) {
    const tab = lectureInfo.tab;
    lectureTitle.textContent = truncate((tab && tab.title) || lectureUrl || 'Tab set');
    lectureAutoTag.classList.toggle('hidden', !isSmartMode);
  } else {
    lectureTitle.textContent = isSmartMode ? 'Waiting for lecture tab\u2026' : 'Not set';
    lectureAutoTag.classList.add('hidden');
  }

  if (movieTabId && movieValid) {
    const tab = movieInfo.tab;
    movieTitle.textContent = truncate((tab && tab.title) || movieUrl || 'Tab set');
    movieAutoTag.classList.toggle('hidden', !isSmartMode);
  } else {
    movieTitle.textContent = isSmartMode ? 'Waiting for movie/TV tab\u2026' : 'Not set';
    movieAutoTag.classList.add('hidden');
  }

  // Same-category conflict awaiting the user's choice — shown regardless of mode,
  // since it can also be triggered while Manual Mode tabs are set, and
  // pendingConflicts is populated straight from chrome.storage.
  const conflictCategory = Object.keys(pendingConflicts || {})[0];
  if (conflictCategory) {
    showConflictBanner(conflictCategory, pendingConflicts[conflictCategory]);
  } else {
    hideConflictBanner();
  }

  if (isSmartMode) {
    smartBannerText.textContent = settings.playMusicOnAppSwitch
      ? 'Auto-detect on · Music plays in VS Code'
      : 'Auto-detecting tabs by URL';
  }

  let activeTabRole = null;
  if (isSmartMode && activeTab) {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'classifyUrl', tabId: activeTab.id, url: activeTab.url });
      if (res && res.success) {
        activeTabRole = res.role;
        setCurrentTabRoleUI(res.role, settings);
      }
    } catch { /* ignore */ }
  }

  // hint when two tabs share the same hostname (two YouTube tabs, etc.)
  try {
    const activeHost  = activeTab  ? hostnameOf(activeTab.url) : null;
    const musicHost   = musicUrl   ? hostnameOf(musicUrl)      : null;
    const lectureHost = lectureUrl ? hostnameOf(lectureUrl)    : null;

    const movieHost = movieUrl ? hostnameOf(movieUrl) : null;

    const alreadyMarked =
      (activeTab && musicTabId   && activeTab.id === musicTabId) ||
      (activeTab && lectureTabId && activeTab.id === lectureTabId) ||
      (activeTab && movieTabId   && activeTab.id === movieTabId);

    const sameAsMusic   = !alreadyMarked && activeHost && musicHost   && activeHost === musicHost;
    const sameAsLecture = !alreadyMarked && activeHost && lectureHost && activeHost === lectureHost;
    const sameAsMovie   = !alreadyMarked && activeHost && movieHost   && activeHost === movieHost;

    if (sameAsMusic || sameAsLecture || sameAsMovie) {
      showSameDomainHint(
        `Two ${activeHost} tabs open. Use "Set current" to mark which one is which.`
      );
    } else {
      hideSameDomainHint();
    }
  } catch { hideSameDomainHint(); }

  // YouTube watch page that isn't manually marked yet — show the music/lecture/movie picker.
  // Shown regardless of the global youtubeMode setting by design (see options.html's
  // comment on this control) — it's a per-tab override, not just a fallback for 'ask'.
  const activeIsMarked =
    (activeTab && musicTabId   && activeTab.id === musicTabId) ||
    (activeTab && lectureTabId && activeTab.id === lectureTabId) ||
    (activeTab && movieTabId   && activeTab.id === movieTabId);
  if (activeTab && isYoutubeWatchUrl(activeTab.url) && !activeIsMarked) {
    ytAmbiguityEl.classList.remove('hidden');
  } else {
    ytAmbiguityEl.classList.add('hidden');
  }

  // audible indicator — reuses the tab objects already fetched above, no extra IPC calls
  const isPlaying = (info) => info && info.tab && info.tab.audible && !(state.extMutedTabIds || []).includes(info.tab.id);
  musicAudibleTag.classList.toggle('hidden', !(musicTabId && musicValid && isPlaying(musicInfo)));
  lectureAudibleTag.classList.toggle('hidden', !(lectureTabId && lectureValid && isPlaying(lectureInfo)));
  movieAudibleTag.classList.toggle('hidden', !(movieTabId && movieValid && isPlaying(movieInfo)));

  // status dot
  const activeId = activeTab ? activeTab.id : null;

  statusDot.classList.remove('music', 'lecture', 'movie', 'smart');
  musicRow.classList.remove('active-row');
  lectureRow.classList.remove('active-row');
  movieRow.classList.remove('active-row');

  if ((activeId === musicTabId && musicValid) || (isSmartMode && activeTabRole === 'music')) {
    statusDot.classList.add('music');
    statusText.textContent = 'Music is active';
    musicRow.classList.add('active-row');
  } else if ((activeId === lectureTabId && lectureValid) || (isSmartMode && activeTabRole === 'lecture')) {
    statusDot.classList.add('lecture');
    statusText.textContent = 'Lecture is active';
    lectureRow.classList.add('active-row');
  } else if ((activeId === movieTabId && movieValid) || (isSmartMode && activeTabRole === 'movie')) {
    statusDot.classList.add('movie');
    statusText.textContent = 'Movie/TV is active';
    movieRow.classList.add('active-row');
  } else if (isSmartMode && (musicTabId || lectureTabId || movieTabId)) {
    if (activeTabRole === 'neutral' && settings && settings.playMusicOnWorkTabs && musicTabId && musicValid && !state.userManuallyStopped) {
      statusDot.classList.add('music');
      statusText.textContent = 'Music playing \u00b7 work tab';
    } else {
      statusDot.classList.add('smart');
      statusText.textContent = 'Smart Mode watching\u2026';
    }
  } else if (isSmartMode) {
    statusDot.classList.add('smart');
    statusText.textContent = 'Smart Mode watching\u2026';
  } else if (!isSmartMode && musicTabId && musicValid && !settings.pauseBothWhenElsewhere && !state.userManuallyStopped) {
    statusDot.classList.add('music');
    statusText.textContent = 'Music playing \u00b7 background';
  } else {
    statusText.textContent = 'No media tab is active';
  }
}

async function loadAndRender() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getState' });
    if (response && response.success) {
      await render(response.state);
    } else {
      showWarning('Could not load state. Try reopening the popup.');
    }
  } catch {
    showWarning('Extension error. Try reloading it in chrome://extensions.');
  }
}

setMusicBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const res = await chrome.runtime.sendMessage({ action: 'setMusicTab', tabId: tab.id, url: tab.url });
    if (!res || !res.success) showWarning('Failed to mark music tab.');
    else await loadAndRender();
  } catch {
    showWarning('Could not mark music tab. Try reopening the popup.');
  }
});

setLectureBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const res = await chrome.runtime.sendMessage({ action: 'setLectureTab', tabId: tab.id, url: tab.url });
    if (!res || !res.success) showWarning('Failed to mark lecture tab.');
    else await loadAndRender();
  } catch {
    showWarning('Could not mark lecture tab. Try reopening the popup.');
  }
});

setMovieBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const res = await chrome.runtime.sendMessage({ action: 'setMovieTab', tabId: tab.id, url: tab.url });
    if (!res || !res.success) showWarning('Failed to mark movie/TV tab.');
    else await loadAndRender();
  } catch {
    showWarning('Could not mark movie/TV tab. Try reopening the popup.');
  }
});

clearBtn.addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'clearBoth' });
    if (!res || !res.success) showWarning('Failed to clear tabs.');
    else await loadAndRender();
  } catch {
    showWarning('Failed to clear tabs.');
  }
});

optionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

async function resolveYoutubeAmbiguity(role) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const res = await chrome.runtime.sendMessage({
      action: 'resolveYoutubeAmbiguity', role, tabId: tab.id, url: tab.url,
    });
    if (!res || !res.success) showWarning('Failed to mark this YouTube tab.');
    else await loadAndRender();
  } catch {
    showWarning('Could not mark this YouTube tab. Try reopening the popup.');
  }
}

ytChoiceMusicBtn.addEventListener('click',   () => resolveYoutubeAmbiguity('music'));
ytChoiceLectureBtn.addEventListener('click', () => resolveYoutubeAmbiguity('lecture'));
ytChoiceMovieBtn.addEventListener('click',   () => resolveYoutubeAmbiguity('movie'));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    loadAndRender();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.audible !== undefined || changeInfo.title !== undefined || changeInfo.url !== undefined) {
    loadAndRender();
  }
});

chrome.tabs.onActivated.addListener(() => {
  loadAndRender();
});

chrome.tabs.onRemoved.addListener(() => {
  loadAndRender();
});

loadAndRender();