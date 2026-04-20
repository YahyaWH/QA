# Android QA Run — run-20260420-1400

**App version:** 2.14.3
**Device:** unknown
**Duration:** 27m   **Turns:** 0   **Status:** completed
**Screens visited:** 3

## Run status
completed — frontier exhausted

## Regressions (previously resolved, now back) — 1

### ☐ f-a3f2 — [HIGH] Crash when opening Route Detail from Schedule
- **Screen:** `RouteDetailScreen` (fp: `a3f2b7…`)
- **Element:** `route-card-item`
- **Category:** A (hard failure)
- **Linear (previous):** WH-0911
- **Artifacts:** [screenshot](findings/f-a3f2/before.png) · [clip](findings/f-a3f2/clip.mp4) · [logcat](findings/f-a3f2/logcat-excerpt.log)
- **Agent reasoning:** logcat: FATAL EXCEPTION: main — java.lang.NullPointerException at RouteDetailScreen.render
- **Evidence:**
  > `logcat: FATAL EXCEPTION: main — java.lang.NullPointerException at RouteDetailScreen.render`

---

## New this run — 2

### ☐ f-b210 — [MED] Save button disabled without explanation on "New Pickup"
- **Screen:** `NewPickupScreen` (fp: `b21fee…`)
- **Element:** `save-pickup-btn`
- **Category:** B (functional bug)
- **Artifacts:** [screenshot](findings/f-b210/before.png) · [clip](findings/f-b210/clip.mp4) · [logcat](findings/f-b210/logcat-excerpt.log)
- **Agent reasoning:** All fields appear valid; no error text shown; button is present but enabled=false.

### ☐ f-c4d5 — [LOW] Danish string shown in English locale on Settings > Notifications
- **Screen:** `SettingsNotificationsScreen` (fp: `c4d5ab…`)
- **Element:** (unknown)
- **Category:** C (UX issue)
- **Artifacts:** [screenshot](findings/f-c4d5/before.png) · [clip](findings/f-c4d5/clip.mp4)
- **Agent reasoning:** Language toggle set to English but button label reads "Gem".

## Previously seen (already triaged; informational) — 1

### ☑ f-0042 — [MED] Search results don't clear after tapping back — WH-1142 (open)
(collapsed)
