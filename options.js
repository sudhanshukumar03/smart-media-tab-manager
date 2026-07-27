// options.js — settings page
// reads/writes go through background.js so we don't duplicate state logic here

const BOOLEAN_TOGGLES = [
  'pauseBothWhenElsewhere',
  'fadeAudio',
  'notifyOnSwitch',
  'smartMode',
  'playMusicOnAppSwitch',
  'playMusicOnWorkTabs',
];

function arrayToTextarea(arr) {
  return (arr || []).join('\n');
}

function textareaToArray(text) {
  return text.split('\n').map(s => s.trim()).filter(s => s.length > 0);
}

async function loadState() {
  const res = await chrome.runtime.sendMessage({ action: 'getState' });
  if (!res || !res.success) throw new Error('Failed to load settings');
  return res.state;
}

async function saveOptions(patch) {
  const res = await chrome.runtime.sendMessage({ action: 'saveOptions', ...patch });
  if (!res || !res.success) throw new Error('Failed to save settings');
  return res.state;
}

// Applies a visual "inert" treatment (dim + non-interactive) to an element.
// Used for the hostname list rows, which only matter in Smart Mode — Manual
// Mode's handleManualSwitch in background.js works purely off pinned tab IDs
// and never calls classifyUrl, so editing these lists in Manual Mode has no
// effect. Uses inline styles rather than a shared CSS class so this doesn't
// require touching options.css's `.dimmed` rule, which is currently scoped
// to specific #ids (#smart-sub-settings) only.
function setRowDimmed(el, dimmed) {
  if (!el) return;
  el.style.opacity = dimmed ? '0.4' : '';
  el.style.pointerEvents = dimmed ? 'none' : '';
}

function syncSmartSubSettings(on, extraRows = []) {
  const sub = document.getElementById('smart-sub-settings');
  if (sub) sub.classList.toggle('dimmed', !on);
  extraRows.forEach(row => setRowDimmed(row, !on));
}

function getYoutubeModeValue() {
  const checked = document.querySelector('input[name="youtubeMode"]:checked');
  return checked ? checked.value : 'ask';
}

function setYoutubeModeValue(mode) {
  document.querySelectorAll('input[name="youtubeMode"]').forEach(r => {
    r.checked = r.value === mode;
  });
}

async function init() {
  let state;
  try {
    state = await loadState();
  } catch {
    const el = document.getElementById('save-status');
    if (el) { el.textContent = 'Could not load settings — reload this page.'; el.classList.remove('hidden'); }
    return;
  }

  const settings = state.settings;

  BOOLEAN_TOGGLES.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = !!settings[id];
  });

  setYoutubeModeValue(settings.youtubeMode || 'ask');
  const lastChoiceNote = document.getElementById('youtube-last-choice-note');
  if (lastChoiceNote) {
    const CHOICE_LABEL = { music: 'Music 🎵', lecture: 'Lecture 📚', movie: 'Movie/TV 🎬' };
    if (settings.youtubeLastChoice) {
      lastChoiceNote.textContent =
        `Remembered choice: unmarked YouTube tabs default to ${CHOICE_LABEL[settings.youtubeLastChoice] || settings.youtubeLastChoice} (last resolved from the popup).`;
      lastChoiceNote.classList.remove('hidden');
    } else {
      lastChoiceNote.classList.add('hidden');
    }
  }

  const musicListEl   = document.getElementById('musicHostnames');
  const lectureListEl = document.getElementById('lectureHostnames');
  const movieListEl   = document.getElementById('movieHostnames');
  if (musicListEl)   musicListEl.value   = arrayToTextarea(state.musicHostnames);
  if (lectureListEl) lectureListEl.value = arrayToTextarea(state.lectureHostnames);
  if (movieListEl)   movieListEl.value   = arrayToTextarea(state.movieHostnames);

  // Rows containing the hostname lists — dimmed together with
  // #smart-sub-settings since both only matter in Smart Mode, even though
  // they live outside that container in the markup.
  const musicListRow   = musicListEl   ? musicListEl.closest('.site-list-row')   : null;
  const lectureListRow = lectureListEl ? lectureListEl.closest('.site-list-row') : null;
  const movieListRow   = movieListEl   ? movieListEl.closest('.site-list-row')   : null;
  const smartDimmableRows = [musicListRow, lectureListRow, movieListRow].filter(Boolean);

  // Remembered same-category "which source to continue" choices — read-only
  // summary here; cleared via the Forget button below (saveOptions'
  // forgetPreferences flag), not editable field-by-field.
  const prefSummaryEl = document.getElementById('category-preference-summary');
  if (prefSummaryEl) {
    const pref = settings.categoryPreference || {};
    const CATEGORY_LABEL = { music: 'Music', lecture: 'Lecture', movie: 'Movie/TV' };
    const entries = Object.entries(pref).filter(([, hostname]) => hostname);
    prefSummaryEl.textContent = entries.length
      ? entries.map(([cat, hostname]) => `${CATEGORY_LABEL[cat] || cat}: ${hostname}`).join(' · ')
      : 'No remembered choices yet.';
  }
  const forgetBtn = document.getElementById('forget-preferences-btn');
  if (forgetBtn) {
    forgetBtn.addEventListener('click', async () => {
      forgetBtn.disabled = true;
      try {
        const newState = await saveOptions({ forgetPreferences: true });
        if (prefSummaryEl) prefSummaryEl.textContent = 'No remembered choices yet.';
        void newState;
      } catch { /* ignore — user can retry */ }
      forgetBtn.disabled = false;
    });
  }

  syncSmartSubSettings(settings.smartMode, smartDimmableRows);
  const smartToggle = document.getElementById('smartMode');
  if (smartToggle) {
    smartToggle.addEventListener('change', () => syncSmartSubSettings(smartToggle.checked, smartDimmableRows));
  }

  const resetMusicBtn   = document.getElementById('reset-music-list');
  const resetLectureBtn = document.getElementById('reset-lecture-list');

  if (resetMusicBtn) {
    resetMusicBtn.addEventListener('click', () => {
      if (musicListEl) musicListEl.value = arrayToTextarea(state.defaultMusicHostnames || state.musicHostnames);
    });
  }
  if (resetLectureBtn) {
    resetLectureBtn.addEventListener('click', () => {
      if (lectureListEl) lectureListEl.value = arrayToTextarea(state.defaultLectureHostnames || state.lectureHostnames);
    });
  }
  const resetMovieBtn = document.getElementById('reset-movie-list');
  if (resetMovieBtn) {
    resetMovieBtn.addEventListener('click', () => {
      if (movieListEl) movieListEl.value = arrayToTextarea(state.defaultMovieHostnames || state.movieHostnames);
    });
  }

  const saveBtn    = document.getElementById('save-btn');
  const saveStatus = document.getElementById('save-status');
  if (!saveBtn || !saveStatus) return; // markup drift — nothing left to wire up safely

  saveBtn.addEventListener('click', async () => {
    const updatedSettings = {};
    BOOLEAN_TOGGLES.forEach(id => {
      const el = document.getElementById(id);
      if (el) updatedSettings[id] = el.checked;
    });
    updatedSettings.youtubeMode = getYoutubeModeValue();

    saveBtn.disabled    = true;
    saveBtn.textContent = 'Saving…';

    try {
      const newState = await saveOptions({
        settings:         updatedSettings,
        musicHostnames:   musicListEl   ? textareaToArray(musicListEl.value)   : undefined,
        lectureHostnames: lectureListEl ? textareaToArray(lectureListEl.value) : undefined,
        movieHostnames:   movieListEl   ? textareaToArray(movieListEl.value)   : undefined,
      });

      // reflect sanitized values back so user sees what was actually saved
      if (musicListEl)   musicListEl.value   = arrayToTextarea(newState.musicHostnames);
      if (lectureListEl) lectureListEl.value = arrayToTextarea(newState.lectureHostnames);
      if (movieListEl)   movieListEl.value   = arrayToTextarea(newState.movieHostnames);

      saveStatus.textContent = 'Saved!';
      saveStatus.classList.remove('hidden');
    } catch {
      saveStatus.textContent = 'Could not save — try again.';
      saveStatus.classList.remove('hidden');
    }

    setTimeout(() => {
      saveStatus.classList.add('hidden');
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Save settings';
    }, 2000);
  });
}

init();