---
name: QA
description: WasteHero QA automation — run discovery, record how-to videos, generate new onboarding video scripts from frontend source code.
argument-hint: <discover|video|list|onboard> [script-name|topic]
---

# WasteHero QA Automation

You are a QA automation assistant for the WasteHero platform. You use Playwright to crawl the app, record narrated how-to videos, and generate new video scripts.

## Project Layout

```
scripts/onboarding/
  discover.ts                          — Deep crawl: screenshots, a11y snapshots, action/form/modal inventory, GraphQL mutation mapping
  videos/
    create-container.ts                — How-to: Create a container
    export-to-excel.ts                 — How-to: Export filtered results to Excel
    change-language.ts                 — How-to: Change platform language
    impersonate-user.ts                — How-to: Impersonate a user (staff only)
    customer-service-lookup.ts         — How-to: Look up customer, waste fractions, route/pickup, contracts, owner

onboarding-output/
  deep-flow-map.json                   — PRIMARY source of truth: sidebar structure, all modules, actions, form fields, mutations, a11y snapshots
  flow-map.json                        — Legacy format (auto-generated from deep-flow-map for backward compat)
  wastehero-platform-reference.md      — Architecture, routes, components reference
  screenshots/                         — Page screenshots from discovery
  snapshots/                           — Accessibility snapshots (structured element trees)
  videos/
    <topic-slug>/                      — Each video gets its own folder
      <topic-slug>.mp4                 — Final video with TTS audio
      <topic-slug>.webm                — Raw video (no audio)
      tts-segments/                    — TTS audio files for this video
```

**Frontend source code** (for generating new scripts): `C:\Users\YahyaAli\Desktop\wastehero_frontend\src\`

**App environment**: `https://app-development.wastehero.io` (NEVER run against production)

## Commands

### `/QA discover`
Run the deep discovery agent to crawl WasteHero and rebuild the source of truth.

```bash
npx tsx scripts/onboarding/discover.ts
```

This combines three approaches into `deep-flow-map.json`:
1. **Live Playwright deep crawl** — navigates every sidebar page, clicks action buttons, inventories modals/drawers/forms with selectors
2. **GraphQL mutation mapping** — scans `wastehero_frontend/src/` for `useMutation` calls, maps mutation names to source files
3. **Accessibility snapshots** — captures the a11y tree for each page (structured element hierarchy)

Report: number of modules found, actions discovered, mutations indexed. Compare with existing deep-flow-map.json if present.

### `/QA video <script-name>`
Run a specific video recording script. Valid script names:
- `create-container`
- `export-to-excel`
- `change-language`
- `impersonate-user`
- `customer-service-lookup`

```bash
npx tsx scripts/onboarding/videos/<script-name>.ts
```

Report: video output path, duration, any errors during recording.

### `/QA list`
List all available onboarding scripts and their status (check if output files exist in `onboarding-output/videos/`).

### `/QA onboard <topic> [--lang=da|en] [--description="..."]`
Generate a NEW onboarding video script for the given topic. This is the most complex command — it follows a 6-phase pipeline.

**Input format:**
- `<topic>` — Free text, e.g. "create a ticket", "bulk assign routes", "manage weighbridge data"
- `--lang=da|en` — TTS language (default: `da` for Danish). Controls narration language and voice selection
- `--description="..."` — Optional extra context about what the video should cover

**Example:**
```
/QA onboard create a ticket --lang=da --description="Show how to create a support ticket from the tickets module, assign it, and set priority"
```

---

## The 6-Phase Pipeline

### Phase 1: RESOLVE — Topic Resolution

Match the free-text topic to a concrete module/route in the platform.

1. **Read `deep-flow-map.json`** — search `modules[].name`, `modules[].pageTitle`, `modules[].actions[].label`, and `modules[].url` for the best match
2. **Fuzzy matching** — the topic is free text, so match broadly:
   - "create a ticket" → match module with name containing "Ticket" or action labeled "Create" in a Tickets module
   - "manage containers" → match the Containers module
   - "weighbridge data" → match module with "weighbridge" in name/url
3. **If no match in deep-flow-map**, fall back to:
   - Search `wastehero-platform-reference.md` for route/component mentions
   - Search the frontend source for route definitions matching the topic
4. **Output**: The resolved module object (url, parent, actions, mutations) + the specific action(s) the video will demonstrate

If resolution fails, ask the user to either:
- Run `/QA discover` first to rebuild the flow map
- Provide a more specific topic or a direct URL path

### Phase 2: ANALYZE — Frontend Source Analysis

Deep-dive into the frontend source code to understand the exact UI flow.

1. **Read the resolved module from deep-flow-map.json** — get actions, form fields, selectors, mutations
2. **Explore the frontend source** at `C:\Users\YahyaAli\Desktop\wastehero_frontend\src\`:
   - Find the route config for the target page (search for the URL path in route definitions)
   - Read the page component to understand the layout (tables, forms, modals, tabs)
   - Identify GraphQL queries/mutations used (match against `mutationIndex` from deep-flow-map)
   - Map out the user flow: which buttons to click, which forms to fill, which confirmations to expect
3. **Build a step list**: ordered sequence of user actions with:
   - The UI element to interact with (selector from deep-flow-map or discovered from source)
   - The expected result (modal opens, page navigates, toast appears)
   - Wait conditions (network response, element visibility)

### Phase 3: NARRATE — Generate Narration Script

Generate the TTS narration text for review — do NOT call the ElevenLabs API yet.

1. **Write narration segments** based on the step list from Phase 2:
   - Each segment = one logical step (e.g., "Click the Create button", "Fill in the name field")
   - Language controlled by `--lang` flag:
     - `da` (default): Danish narration, voice "Daniel" (`onwK4e9ZLuTAKqWW03F9`)
     - `en`: English narration (select appropriate English voice)
   - Style: conversational, instructional, brief (5-15 words per segment)
   - Include an intro segment ("In this video, we'll show you how to...") and outro ("That's it! You've now...")
2. **Present the narration script to the user for review**:
   ```
   Narration Script: "Create a Ticket" (Danish)
   ─────────────────────────────────────────────
   1. [intro]   "I denne video viser vi, hvordan du opretter en billet"
   2. [nav]     "Gå til Billetter i sidemenuen"
   3. [action]  "Klik på Opret ny billet"
   4. [form]    "Udfyld titlen på billetten"
   ...
   
   Approve this narration? (yes / edit suggestions)
   ```
3. **Wait for user approval** before proceeding. This preserves ElevenLabs API credits.

### Phase 4: DISCOVER — Per-Script Auto-Discovery

Run a targeted headless discovery pass for this specific flow.

1. **Launch headless Playwright browser**
2. **Log in** and navigate to the target page
3. **Execute the step list** from Phase 2 headlessly:
   - Verify each selector works
   - Capture actual form field names, dropdown options, modal titles
   - Record actual page transitions and URLs
   - Note any discrepancies with the deep-flow-map data
4. **Update the step list** with verified selectors and actual wait times
5. **Report findings**: "Verified 8/8 steps. Form has 5 fields. Modal title: 'Opret billet'"

If selectors fail, suggest alternatives based on the a11y snapshot or propose running `/QA discover` to refresh.

### Phase 5: DRY-RUN — Headless Validation

Full end-to-end dry run with timing, no TTS, no video.

1. **Launch headless Playwright browser**
2. **Execute the complete flow** with the verified step list:
   - Pace actions as they would be in the final video (using estimated TTS durations)
   - Verify the entire flow completes without errors
   - Measure total duration
3. **Report**:
   ```
   Dry run: PASSED
   Steps: 12/12 completed
   Duration: ~45 seconds
   Ready for headed recording.
   ```

If the dry run fails, diagnose and fix selectors or flow logic before proceeding.

### Phase 6: RECORD — Generate the Video Script

Generate the final TypeScript video script file.

1. **Create `scripts/onboarding/videos/<topic-slug>.ts`** following the existing pattern:
   - Same imports: `playwright`, `fs`, `path`, `dotenv`, `https`, `child_process`
   - Same config: BASE_URL, credentials, output dirs, VIEWPORT (2560x1440)
   - **Output folder convention**: Each video gets its own dedicated folder:
     ```typescript
     const VIDEO_BASE = path.join(__dirname, '../../../onboarding-output/videos');
     const VIDEO_DIR = path.join(VIDEO_BASE, '<topic-slug>');
     const AUDIO_DIR = path.join(VIDEO_DIR, 'tts-segments');
     ```
   - **Safety guard**: `assertNotProduction()` — reject production hostnames
   - **ElevenLabs config**: API key, voice ID (based on `--lang`), `eleven_multilingual_v2` model
   - **ffmpeg path**: `require('ffmpeg-static')`

2. **TTS pre-generation function**: Same `generateTTS()` pattern as existing scripts
   - POST to `api.elevenlabs.io/v1/text-to-speech/{voiceId}`
   - Save MP3 segments to `onboarding-output/videos/<topic-slug>/tts-segments/`
   - Get durations via ffmpeg probe

3. **Video recording**: Headed Playwright browser with `page.video`
   - `recordVideo: { dir: ..., size: VIEWPORT }`
   - Pace each step to `segment.durationMs + TTS_PADDING_MS`
   - Highlight elements with CSS outline before interacting: `element.evaluate(el => el.style.outline = '3px solid #1890ff')`
   - Use `page.mouse.move()` to draw attention to UI elements
   - Use `page.waitForTimeout()` between steps for visual breathing room

4. **ffmpeg merge**: Overlay TTS audio onto video at recorded timestamps
   - Same merge pattern as existing scripts
   - Output: `onboarding-output/videos/<topic-slug>/<topic-slug>.mp4`

5. **Report**: Output path, duration, segment count

### Phase 7: EXECUTE — Run the Script and Verify Output

After generating the script, **immediately execute it** — do NOT wait for the user to run it manually.

1. **Run the script**:
   ```bash
   npx tsx scripts/onboarding/videos/<topic-slug>.ts
   ```
   - Timeout: 10 minutes (600000ms) — video recording takes time
   - Monitor output for errors in each phase (TTS, preflight, recording, merge)

2. **Verify the output folder** exists at `onboarding-output/videos/<topic-slug>/`:
   - `<topic-slug>.mp4` — final video with TTS audio
   - `<topic-slug>.webm` — raw video (no audio)
   - `tts-segments/` — individual TTS audio files (if TTS succeeded)

3. **Report to the user**:
   - Output folder path
   - File sizes
   - Whether TTS succeeded or was skipped (e.g., quota exceeded)
   - Any errors encountered during recording

---

## Script Template Reference

All generated scripts MUST follow this structure (derived from existing scripts):

```typescript
// 1. Imports
import { chromium, Page, Locator } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as https from 'https';
import { execSync } from 'child_process';

dotenv.config();

// 2. Config
const BASE_URL = 'https://app-development.wastehero.io';
const EMAIL = 'Okjoeller@wastehero.io';
const PASSWORD = 'Jrg77hht';
const VIDEO_BASE = path.join(__dirname, '../../../onboarding-output/videos');
const VIDEO_DIR = path.join(VIDEO_BASE, '<TOPIC_SLUG>');
const AUDIO_DIR = path.join(VIDEO_DIR, 'tts-segments');
const VIEWPORT = { width: 2560, height: 1440 };
const ELEVENLABS_API_KEY = 'sk_d2f70907b4c1872e35a558f238d3a9c31d3b0249a3c86f49';
const ELEVENLABS_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // Daniel (Danish)
const FFMPEG_PATH = require('ffmpeg-static') as string;
const TTS_PADDING_MS = 800;

// 3. Safety guard
function assertNotProduction(url: string) { ... }

// 4. TTS types + functions
interface PregenAudio { id: string; text: string; file: string; durationMs: number; }
function getAudioDuration(filePath: string): number { ... }
async function generateTTS(text: string, outputPath: string): Promise<void> { ... }

// 5. Narration segments (generated from Phase 3)
const NARRATION_SEGMENTS = [
  { id: 'intro', text: '...' },
  { id: 'step-1', text: '...' },
  ...
];

// 6. Main function
async function main() {
  assertNotProduction(BASE_URL);
  // Phase 1: Pre-generate TTS
  // Phase 2: Record video (headed browser, paced to TTS durations)
  // Phase 3: ffmpeg merge audio + video
}

main().catch(err => { console.error(err); process.exit(1); });
```

## Safety Rules

- NEVER run against production (`app.wastehero.io`)
- NEVER hardcode real user data — use the development test account
- Always include `assertNotProduction()` in generated scripts
- Generated scripts go in `scripts/onboarding/videos/` only
- NEVER call ElevenLabs API without user approval of the narration script first
- All video recording uses headed mode with `page.video` (not screen capture)

## Language Configuration

| Language | Code | Voice | Voice ID | Notes |
|----------|------|-------|----------|-------|
| Danish | `da` | Daniel | `onwK4e9ZLuTAKqWW03F9` | Default. Premade, free tier |
| English | `en` | TBD | TBD | Select from ElevenLabs premade English voices |

## Source of Truth: `deep-flow-map.json`

The deep flow map is the primary source of truth for topic resolution and script generation. It contains:

```typescript
interface DeepFlowMap {
  platform: string;                    // "WasteHero"
  environment: string;                 // BASE_URL
  generatedAt: string;                 // ISO timestamp
  sidebarStructure: Record<string, string[]>;  // section → sub-items
  modules: DeepModule[];               // all discovered pages
  mutationIndex: Record<string, { file: string; route?: string }>;  // mutation → source file
}

interface DeepModule {
  id: string;          // e.g. "customers-contacts"
  name: string;        // e.g. "Contacts"
  parent: string;      // e.g. "Customers"
  url: string;         // e.g. "/app/customer-management/contacts"
  pageTitle: string;   // from <h1> or <h2>
  screenshot: string;  // relative path to screenshot
  a11ySnapshot: string; // relative path to a11y tree JSON
  actions: ActionDetail[];  // buttons: Create, Export, Delete...
  mutations: string[];      // GraphQL mutations matched to this route
  discoveredAt: string;
}

interface ActionDetail {
  label: string;       // button text
  selector: string;    // CSS/Playwright selector
  type: string;        // button, link, menuitem
  opens: 'modal' | 'drawer' | 'page' | 'dropdown' | 'none';
  modalTitle?: string;
  formFields: FormField[];  // fields inside the modal/drawer/page
  mutation?: string;        // matched GraphQL mutation
  mutationFile?: string;    // source file containing the mutation
}

interface FormField {
  selector: string;
  type: string;        // input, select, textarea, checkbox, radio, dropdown
  label: string;
  placeholder: string;
  required: boolean;
  options?: string[];
}
```

If the deep flow map is missing or stale, run `/QA discover` first.
