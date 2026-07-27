# Performance Notes

This document covers the behaviour-neutral changes made to keep the extension fast and lean. Nothing the user sees, hears, or experiences changed — these are internal improvements only.

---

## 1. Batched `chrome.storage.local` writes

**What changed:** Every logical operation that previously made multiple sequential `setState()` calls was consolidated into a single call.

Key examples:
- `activateCategoryTab` — previously called `setState` twice (once to update the category tab/URL fields, then again after `pauseCategory`). All updates from one activation are now batched into a single write.
- `settleConflict` — previously wrote `pendingConflicts` and category fields separately. Now combined into one.
- `markExtMuted` — already isolated; confirmed it only writes once per call.

**Why it matters:** Each `setState` is a full read-modify-write cycle against `chrome.storage.local`. Halving the number of writes in hot paths (tab switches, conflict resolution) reduces latency and closes the window during which a service-worker restart could catch state mid-update.

---

## 2. Single `chrome.tabs.get` per tracked tab in `popup.js`

**What changed:** `render()` previously called `chrome.tabs.get` up to three separate times for the same tab — once for existence, once for the title, once for audible state. These were replaced with a single `fetchTabInfo(tabId)` helper that fetches the tab once and reuses the result for all three checks.

**Why it matters:** Reduces IPC round trips from up to 9 (3 tabs × 3 checks) to 3 on every popup open and every `loadAndRender()` call. Also removes a subtle inconsistency where tab state could change between the three reads, causing the title and audible indicator to reflect different moments in time.

---

## 3. Debounced `chrome.tabs.onUpdated` (URL change path)

**What changed:** The `onUpdated` URL-change handler coalesces rapid URL changes on the same tab into a single reclassification, using a 200ms debounce window.

**Why it matters:** SPAs like Spotify and YouTube frequently fire several `onUpdated` events within milliseconds for what is logically one navigation (a query-param update followed immediately by the real path change). Without debouncing, each event independently reads state, reclassifies, and potentially triggers a pause/play round trip. With debouncing, the same outcome is reached with one storage read and one potential content-script injection.

---

## 4. Avoided redundant content-script injection

**What confirmed:** `safeSendMessage` in `background.js` already injects `content.js` lazily — only after a first `sendMessage` fails with a "no receiver" error. `controlTab` does not attempt injection on healthy tabs. No change needed.

---

## 5. Single tab fetch in audible detection handler

**What changed:** The background-tab audible detection handler (`changeInfo.audible === true`) previously called `chrome.tabs.get(tabId)` twice when role was determined by URL classification — once inside the classification branch and again unconditionally below it. The variable is now hoisted so the already-fetched object is reused.

---

## 6. Memory and listener hygiene

**Findings:**

- **Conflict timeout timers** (`_conflictTimeoutTimers`) — confirmed cleared in three places: when the user responds, when the 15s timeout fires itself, and in `chrome.tabs.onRemoved` when a tab involved in the conflict closes. No leaks.
- **`_explicitCooldown` map** — entries are deleted in `chrome.tabs.onRemoved`. Long-lived sessions with many tab open/close cycles won't accumulate stale entries.
- **`_tabUpdateTimers` map** — debounce timers are cleared in `chrome.tabs.onRemoved`, preventing a timer from firing after its tab is gone and attempting a `chrome.tabs.get` on a dead tab ID.
- **`_lastHandledSwitch`** — reset in `chrome.tabs.onRemoved` when the removed tab matches.
- **`content.js` MutationObserver** — does not disconnect on SPA navigation. For very long-lived tabs the observer accumulates across in-page navigations, but reconnecting it would require detecting SPA navigation from within the content script (fragile). Left as a future improvement candidate; no behaviour change made.

---

## 7. Logging noise

**What confirmed:** All debug-level logging is gated behind `const DEBUG_LOGGING = false`. When false, no template strings are evaluated and no `console.log` calls execute in the hot paths. The only unconditional log is `console.warn` in `askUserToChooseSource` when notification creation fails — a genuine error signal worth keeping.

No code change needed.

---

## What was not changed

- **`chrome.storage.sync`** — cross-device sync was out of scope.
- **MutationObserver reconnection in `content.js`** — would alter observable behaviour on SPA navigation; left as a future suggestion only.
