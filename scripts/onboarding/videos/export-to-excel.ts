/**
 * How-To Video: Eksportér filtrerede resultater til Excel
 *
 * Strategy: TTS-first recording
 *   Phase 1 — Pre-generate all TTS audio and get exact durations
 *   Phase 2 — Record video, pacing each label to match its TTS duration
 *   Phase 3 — Merge TTS audio into the video at the recorded timestamps
 *
 * SAFETY: Only runs against development/staging.
 */

import { chromium, Page, Locator } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as https from 'https';
import { execSync } from 'child_process';

dotenv.config();

const BASE_URL = 'https://app-development.wastehero.io';
const EMAIL = 'Okjoeller@wastehero.io';
const PASSWORD = 'Jrg77hht';

const VIDEO_DIR = path.join(__dirname, '../../../onboarding-output/videos');
const AUDIO_DIR = path.join(VIDEO_DIR, 'tts-segments');

const VIEWPORT = { width: 2560, height: 1440 };

// ElevenLabs TTS config
const ELEVENLABS_API_KEY = 'sk_d2f70907b4c1872e35a558f238d3a9c31d3b0249a3c86f49';
const ELEVENLABS_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // Daniel - Steady Broadcaster (premade, free tier)

const FFMPEG_PATH = require('ffmpeg-static') as string;

// Extra padding (ms) after each TTS segment finishes before the next one begins
const TTS_PADDING_MS = 800;

function assertNotProduction(url: string) {
  const hostname = new URL(url).hostname;
  if (!hostname.includes('development') && !hostname.includes('staging') && !hostname.includes('localhost')) {
    throw new Error(`SAFETY ABORT: "${hostname}" is not a safe environment.`);
  }
}

// ─── TTS pre-generation ─────────────────────────────────────────────────────

interface PregenAudio {
  id: string;
  text: string;
  file: string;
  durationMs: number;
}

function getAudioDuration(filePath: string): number {
  // ffmpeg -i always writes info to stderr and exits non-zero with no output target
  try {
    execSync(`"${FFMPEG_PATH}" -i "${filePath}" 2>"${filePath}.info"`, {
      encoding: 'utf8',
      timeout: 10000,
    });
  } catch {
    // Expected: ffmpeg exits non-zero when only reading info
  }

  try {
    const info = fs.readFileSync(`${filePath}.info`, 'utf8');
    fs.unlinkSync(`${filePath}.info`);
    const match = info.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (match) {
      const [, h, m, s, cs] = match;
      return Math.round(
        (parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(cs) / 100) * 1000
      );
    }
  } catch {}

  // Fallback: estimate ~2.5 words/sec for Danish
  const fileSize = fs.statSync(filePath).size;
  // MP3 at 128kbps: ~16000 bytes/sec
  if (fileSize > 0) {
    return Math.round((fileSize / 16000) * 1000);
  }
  return 5000;
}

async function generateTTS(text: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    });

    const options = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => reject(new Error(`ElevenLabs API ${res.statusCode}: ${body}`)));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        fs.writeFileSync(outputPath, Buffer.concat(chunks));
        resolve();
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// All narration texts, keyed by an ID so we can look up durations during recording
const NARRATIONS: { id: string; text: string }[] = [
  { id: 'welcome',        text: 'Velkommen til WasteHero — start med at logge ind på platformen med dine loginoplysninger' },
  { id: 'login-fields',   text: 'Indtast dit brugernavn og adgangskode, og klik derefter på "Log ind"' },
  { id: 'dashboard',      text: 'Du er nu på Dashboardet — hovedoverblikket over dine affaldsadministrationsoperationer' },
  { id: 'open-analytics', text: 'For at eksportere data skal du åbne sektionen "Data & Analytics" i venstre sidepanel' },
  { id: 'sidebar-items',  text: 'Sidepanelet udvides og viser: Overview, Dashboards, Data Exports, Classic Exports og Data Imports' },
  { id: 'click-exports',  text: 'Klik på "Data Exports" — her opretter og administrerer du genanvendelige eksportskabeloner' },
  { id: 'templates-list', text: 'Denne side viser alle gemte eksportskabeloner — hver enkelt definerer, hvilke data der skal eksporteres, og hvem der har oprettet den' },
  { id: 'export-type',    text: 'Bemærk kolonnen "Export type" — du kan oprette eksporter for Containere, Ejendomme, Tickets eller Ruter' },
  { id: 'click-view',     text: 'Klik på "View" ved en eksportskabelon for at se konfigurationen — kolonner, filtre og outputformat' },
  { id: 'config-page',    text: 'Dette er eksportkonfigurationssiden — her kan du tilpasse, hvilke kolonner der skal medtages, anvende filtre for at indsnævre dine data og vælge outputformat' },
  { id: 'run-export',     text: 'Når du er klar, klik på eksportknappen for at generere din fil — den vil blive vist under Classic Exports, når den er færdig' },
  { id: 'run-export-alt', text: 'Når du har konfigureret dine filtre og kolonner, kør eksporten — den genererede fil vises under Classic Exports' },
  { id: 'goto-classic',   text: 'Lad os nu gå til "Classic Exports" for at finde og downloade de færdige eksportfiler' },
  { id: 'classic-list',   text: 'Classic Exports viser alle færdige eksporter — hver række indeholder eksporttype, status, fremskridt og en fil, der kan downloades' },
  { id: 'click-xlsx',     text: 'Klik på et filnavn for at downloade det — Excel-filer ender på .xlsx og CSV-filer ender på .csv' },
  { id: 'csv-note',       text: 'CSV-eksporter er også tilgængelige — nyttige til import i andre systemer eller scripts' },
  { id: 'summary',        text: 'Det var det! Kort opsummeret: Brug "Data Exports" til at oprette skabeloner, og "Classic Exports" til at downloade de genererede Excel- eller CSV-filer' },
];

async function preGenerateAllTTS(): Promise<Map<string, PregenAudio>> {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const map = new Map<string, PregenAudio>();

  console.log(`\n── Fase 1: Pre-genererer ${NARRATIONS.length} TTS-segmenter ──`);

  for (let i = 0; i < NARRATIONS.length; i++) {
    const { id, text } = NARRATIONS[i];
    const file = path.join(AUDIO_DIR, `${id}.mp3`);
    const shortText = text.length > 55 ? text.substring(0, 55) + '...' : text;
    process.stdout.write(`  [${i + 1}/${NARRATIONS.length}] ${shortText}`);

    // Cache: skip API call if file already exists with real content
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) {
      const durationMs = getAudioDuration(file);
      map.set(id, { id, text, file, durationMs });
      console.log(` -> cached ${(durationMs / 1000).toFixed(1)}s`);
      continue;
    }

    try {
      await generateTTS(text, file);
      const durationMs = getAudioDuration(file);
      map.set(id, { id, text, file, durationMs });
      console.log(` -> ${(durationMs / 1000).toFixed(1)}s`);
    } catch (err: any) {
      console.log(` -> FEJL: ${err.message}`);
    }
  }

  console.log(`  Genereret: ${map.size}/${NARRATIONS.length}\n`);
  return map;
}

// ─── Recording helpers ──────────────────────────────────────────────────────

interface TimedSegment {
  id: string;
  timestampMs: number;
}

const timedSegments: TimedSegment[] = [];
let videoStartTime = 0;

/** Show a label and wait for the TTS duration (+ padding) so narrations never overlap */
async function showLabelTimed(
  page: Page,
  narrationId: string,
  ttsMap: Map<string, PregenAudio>,
  position: 'bottom' | 'top' = 'bottom',
  minWaitMs = 2000,
) {
  const audio = ttsMap.get(narrationId);
  const text = audio?.text || NARRATIONS.find((n) => n.id === narrationId)?.text || narrationId;
  const ttsDuration = audio?.durationMs || 3000;
  const waitTime = Math.max(minWaitMs, ttsDuration + TTS_PADDING_MS);

  // Record timestamp for ffmpeg merge
  timedSegments.push({ id: narrationId, timestampMs: Date.now() - videoStartTime });

  // Inject on-screen label
  await page.evaluate(
    ({ label, pos }) => {
      document.querySelectorAll('.ant-notification, .ant-message, [class*="toast"], [class*="notification"]').forEach(
        (n) => (n as HTMLElement).style.display = 'none'
      );
      let el = document.getElementById('__vid_label');
      if (!el) {
        el = document.createElement('div');
        el.id = '__vid_label';
        document.body.appendChild(el);
      }
      el.style.cssText = `
        position: fixed;
        ${pos === 'bottom' ? 'bottom: 48px' : 'top: 140px'};
        left: 50%; transform: translateX(-50%);
        background: rgba(15, 23, 42, 0.95);
        color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 26px; font-weight: 500; line-height: 1.5;
        padding: 20px 44px; border-radius: 14px;
        z-index: 2147483647; pointer-events: none;
        transition: opacity 0.35s ease;
        max-width: 70%; text-align: center;
        box-shadow: 0 8px 32px rgba(0,0,0,0.45);
        letter-spacing: 0.2px;
      `;
      el.textContent = label;
      el.style.opacity = '1';
    },
    { label: text, pos: position }
  );

  // Wait for the TTS to finish + padding
  await page.waitForTimeout(waitTime);
}

async function hideLabel(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById('__vid_label');
    if (el) el.style.opacity = '0';
  });
}

async function showStepBadge(page: Page, stepNum: number, title: string) {
  await page.evaluate(
    ({ num, t }) => {
      document.querySelectorAll('.ant-notification, .ant-message, [class*="toast"]').forEach(
        (n) => (n as HTMLElement).style.display = 'none'
      );
      let el = document.getElementById('__vid_step');
      if (!el) {
        el = document.createElement('div');
        el.id = '__vid_step';
        document.body.appendChild(el);
      }
      el.style.cssText = `
        position: fixed; top: 80px; right: 40px;
        background: #2563eb; color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 20px; font-weight: 600;
        padding: 12px 24px; border-radius: 10px;
        z-index: 2147483646; pointer-events: none;
        transition: opacity 0.3s ease;
        box-shadow: 0 4px 16px rgba(37,99,235,0.4);
      `;
      el.innerHTML = `<span style="opacity:0.7">Trin ${num}</span> &mdash; ${t}`;
      el.style.opacity = '1';
    },
    { num: stepNum, t: title }
  );
}

async function hideStepBadge(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById('__vid_step');
    if (el) el.style.opacity = '0';
  });
}

/**
 * Spotlight effect: dims the entire screen except the target element.
 * Places an element over the target with a huge box-shadow that covers
 * the rest of the viewport — simple, reliable, smooth.
 */
async function highlight(locator: Locator, padding = 10) {
  try {
    const box = await locator.boundingBox();
    if (!box) return;

    await locator.page().evaluate(
      ({ x, y, w, h, pad }) => {
        let spot = document.getElementById('__vid_spotlight');
        if (!spot) {
          spot = document.createElement('div');
          spot.id = '__vid_spotlight';
          document.body.appendChild(spot);
        }
        spot.style.cssText = `
          position: fixed;
          top: ${y - pad}px;
          left: ${x - pad}px;
          width: ${w + pad * 2}px;
          height: ${h + pad * 2}px;
          border-radius: 10px;
          box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
          z-index: 2147483645;
          pointer-events: none;
          transition: all 0.35s ease;
          opacity: 1;
        `;

        // Keep label + step badge above the dim
        const label = document.getElementById('__vid_label');
        if (label) label.style.zIndex = '2147483647';
        const step = document.getElementById('__vid_step');
        if (step) step.style.zIndex = '2147483647';
      },
      { x: box.x, y: box.y, w: box.width, h: box.height, pad: padding }
    );
  } catch {}
}

async function unhighlight(locator: Locator) {
  try {
    await locator.page().evaluate(() => {
      const spot = document.getElementById('__vid_spotlight');
      if (spot) spot.style.opacity = '0';
    });
  } catch {}
}

async function wait(page: Page, ms: number) {
  await page.waitForTimeout(ms);
}

// ─── Pre-flight: set platform language to Danish ────────────────────────────

async function setLanguageToDanish(): Promise<void> {
  console.log('── Setup: Skifter platformsprog til dansk ──');
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'da-DK' });
  const pg = await ctx.newPage();

  try {
    // Log in
    await pg.goto(`${BASE_URL}/login`);
    await pg.waitForTimeout(3000);
    await pg.fill('input[placeholder="Username"]', EMAIL);
    await pg.fill('input[placeholder="Password"]', PASSWORD);
    await pg.click('button:has-text("Log in")');
    await pg.waitForURL((url) => !url.toString().includes('/login'), { timeout: 20000 });
    await pg.waitForTimeout(4000);

    // Navigate to user profile
    await pg.goto(`${BASE_URL}/app/profile/information`);
    await pg.waitForTimeout(5000);

    // Debug: screenshot + dump all form items to find the language select
    await pg.screenshot({ path: path.join(VIDEO_DIR, 'debug-profile.png') });
    const formItems = await pg.evaluate(() => {
      const items: string[] = [];
      document.querySelectorAll('.ant-form-item').forEach((fi) => {
        const label = fi.querySelector('.ant-form-item-label')?.textContent?.trim() || '';
        const value = fi.querySelector('.ant-select-selection-item')?.textContent?.trim() ||
                      (fi.querySelector('input') as HTMLInputElement)?.value || '';
        if (label) items.push(`${label}: ${value}`);
      });
      return items;
    });
    console.log('  Profilfelter fundet:', formItems.join(' | '));

    // Find the Language form item by scanning all form items for one that
    // currently shows a language value (EN, DA, Danish, English, etc.)
    const langFormItem = pg.locator('.ant-form-item').filter({
      hasText: /Language|Sprog|Sprache/,
    }).first();

    let found = await langFormItem.isVisible({ timeout: 3000 }).catch(() => false);

    // Fallback: find by current value containing a known language code
    if (!found) {
      const altItem = pg.locator('.ant-form-item').filter({
        has: pg.locator('.ant-select-selection-item', { hasText: /English|Danish|Norwegian|Finnish|Swedish|Dansk|Engelsk/ }),
      }).first();
      found = await altItem.isVisible({ timeout: 3000 }).catch(() => false);
      if (found) {
        console.log('  Fundet sprogvælger via værdi-match');
      }
    }

    if (!found) {
      // Try scrolling down — the Preference section might be below the fold
      await pg.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await pg.waitForTimeout(1000);
      found = await langFormItem.isVisible({ timeout: 3000 }).catch(() => false);
    }

    if (found) {
      const langSelect = langFormItem.locator('.ant-select').first();
      const currentValue = await langSelect.locator('.ant-select-selection-item').textContent().catch(() => '');
      console.log(`  Nuværende sprog: "${currentValue}"`);

      if (currentValue?.match(/Danish|Dansk/i)) {
        console.log('  Allerede dansk — springer over.\n');
        return;
      }

      // Open the dropdown — click the selector to spawn the popup
      await langSelect.click();
      await pg.waitForTimeout(1500);

      // Ant Design renders dropdown options in a portal div at document root.
      // The popup container has class "ant-select-dropdown" and contains
      // ".rc-virtual-list" with the actual option items.
      const dropdownPopup = pg.locator('.ant-select-dropdown').last();
      await dropdownPopup.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      await pg.waitForTimeout(500);

      // Try multiple selectors for the Danish option
      let danishOption = dropdownPopup.locator('.ant-select-item-option', { hasText: /Danish|Dansk/ }).first();
      let danishVisible = await danishOption.isVisible({ timeout: 2000 }).catch(() => false);

      if (!danishVisible) {
        // Fallback: search in the virtual list content
        danishOption = dropdownPopup.locator('.ant-select-item-option-content', { hasText: /Danish|Dansk/ }).first();
        danishVisible = await danishOption.isVisible({ timeout: 2000 }).catch(() => false);
      }

      if (!danishVisible) {
        // Last resort: search anywhere in the page for the dropdown option
        danishOption = pg.locator('.ant-select-item-option-content').filter({ hasText: /Danish|Dansk/ }).first();
        danishVisible = await danishOption.isVisible({ timeout: 2000 }).catch(() => false);
      }

      if (danishVisible) {
        await danishOption.click();
        await pg.waitForTimeout(800);

        // Save — look for submit button
        const saveBtn = pg.locator('button[type="submit"], button').filter({ hasText: /Save|Update|Gem|Opdater|Submit/ }).first();
        if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await saveBtn.click();
          await pg.waitForTimeout(4000);
          console.log('  Sprog ændret til dansk og gemt.\n');
        } else {
          console.log('  Gem-knap ikke fundet.\n');
        }
      } else {
        // Debug: dump all visible dropdown content
        const allDropdowns = await pg.evaluate(() => {
          return Array.from(document.querySelectorAll('.ant-select-dropdown'))
            .map((dd) => dd.innerHTML.substring(0, 500));
        });
        console.log(`  Dropdown HTML (${allDropdowns.length} popups):`);
        allDropdowns.forEach((h, i) => console.log(`    [${i}]: ${h.substring(0, 200)}`));
        console.log('  "Danish" option ikke fundet.\n');
      }
    } else {
      console.log('  Sprogvælger ikke fundet på profil-siden.\n');
    }
  } catch (err: any) {
    console.log(`  Setup advarsel: ${err.message}\n`);
  } finally {
    await pg.close();
    await ctx.close();
    await browser.close();
  }
}

// ─── ffmpeg merge ───────────────────────────────────────────────────────────

function mergeAudioWithVideo(
  videoPath: string,
  outputPath: string,
  ttsMap: Map<string, PregenAudio>,
): void {
  // Build list of segments that have both a timestamp and an audio file
  const validPairs = timedSegments
    .map((ts) => ({ ...ts, audio: ttsMap.get(ts.id) }))
    .filter((p): p is typeof p & { audio: PregenAudio } => !!p.audio && fs.existsSync(p.audio.file));

  if (validPairs.length === 0) {
    console.log('Ingen lydsegmenter at flette — kopierer video uændret.');
    fs.copyFileSync(videoPath, outputPath);
    return;
  }

  console.log(`\nFletter ${validPairs.length} lydsegmenter med video...`);

  const inputs = validPairs.map((p) => `-i "${p.audio.file}"`).join(' ');
  const filterParts: string[] = [];
  const mixInputs: string[] = [];

  validPairs.forEach((pair, i) => {
    const inputIdx = i + 1; // 0 is the video
    const delayMs = pair.timestampMs;
    filterParts.push(
      `[${inputIdx}:a]adelay=${delayMs}|${delayMs},aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`
    );
    mixInputs.push(`[a${i}]`);
  });

  const mixFilter = `${mixInputs.join('')}amix=inputs=${validPairs.length}:duration=longest:dropout_transition=2[aout]`;
  const filterComplex = `${filterParts.join(';')};${mixFilter}`;

  const cmd = `"${FFMPEG_PATH}" -y -i "${videoPath}" ${inputs} -filter_complex "${filterComplex}" -map 0:v -map "[aout]" -c:v libx264 -crf 20 -preset fast -c:a aac -b:a 192k "${outputPath}"`;

  console.log('Kører ffmpeg...');
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 300000 });
    console.log(`Video med lyd gemt: ${outputPath}`);
  } catch (err: any) {
    console.error('ffmpeg fejlede:', err.stderr?.toString().slice(-500) || err.message);
    console.log('Kopierer video uden lyd som fallback.');
    fs.copyFileSync(videoPath, outputPath);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  assertNotProduction(BASE_URL);
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  const destWebm = path.join(VIDEO_DIR, 'export-to-excel.webm');
  const destMp4 = path.join(VIDEO_DIR, 'export-to-excel.mp4');
  if (fs.existsSync(destWebm)) fs.unlinkSync(destWebm);
  if (fs.existsSync(destMp4)) fs.unlinkSync(destMp4);

  console.log('Optager: Eksportér filtrerede resultater til Excel');
  console.log(`Opløsning: ${VIEWPORT.width}x${VIEWPORT.height}`);
  console.log('TTS: ElevenLabs (dansk)');

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 1 — Pre-generér TTS
  // ══════════════════════════════════════════════════════════════════════════
  const ttsMap = await preGenerateAllTTS();

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 1.5 — Set platform language to Danish (headless, before recording)
  // ══════════════════════════════════════════════════════════════════════════
  await setLanguageToDanish();

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 2 — Optag video (paced by TTS durations)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── Fase 2: Optager video ──\n');

  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
    locale: 'da-DK',
  });
  const page = await context.newPage();
  videoStartTime = Date.now();

  // Helper: find sidebar item by trying multiple text patterns (handles EN/DA)
  async function findSidebarItem(...patterns: string[]): Promise<Locator | null> {
    for (const pattern of patterns) {
      const loc = page.locator('li span').filter({ hasText: new RegExp(`^${pattern}$`, 'i') }).first();
      if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) return loc;
    }
    return null;
  }

  async function findMenuItem(...patterns: string[]): Promise<Locator | null> {
    for (const pattern of patterns) {
      const loc = page.locator('li[role="menuitem"] span').filter({ hasText: new RegExp(`^${pattern}$`, 'i') }).first();
      if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) return loc;
    }
    return null;
  }

  async function dismissToasts() {
    await page.evaluate(() => {
      document.querySelectorAll('.ant-notification, .ant-message, [class*="toast"], [class*="Success"], [class*="notification"]').forEach(
        (n) => (n as HTMLElement).style.display = 'none'
      );
    });
  }

  try {
    // ── TRIN 1: Log ind ──────────────────────────────────────────────────
    console.log('Trin 1: Log ind');
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');
    await wait(page, 1000);

    await showStepBadge(page, 1, 'Log ind');
    await showLabelTimed(page, 'welcome', ttsMap);

    const emailInput = page.locator('input[placeholder="Username"]');
    await highlight(emailInput);
    await wait(page, 600);
    await emailInput.fill(EMAIL);
    await wait(page, 500);
    await unhighlight(emailInput);

    const passInput = page.locator('input[placeholder="Password"]');
    await highlight(passInput);
    await wait(page, 400);
    await passInput.fill(PASSWORD);
    await wait(page, 500);
    await unhighlight(passInput);

    const loginBtn = page.locator('button:has-text("Log in")');
    await highlight(loginBtn);
    await showLabelTimed(page, 'login-fields', ttsMap);
    await loginBtn.click();
    await unhighlight(loginBtn);

    await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 20000 });
    await page.waitForLoadState('domcontentloaded');
    await wait(page, 2000);
    await dismissToasts();
    await wait(page, 500);

    await showLabelTimed(page, 'dashboard', ttsMap);

    // ── TRIN 2: Naviger til Data Exports ─────────────────────────────────
    console.log('Trin 2: Naviger til Data & Analytics > Data Exports');
    await hideLabel(page);
    await showStepBadge(page, 2, 'Naviger til Data Exports');
    await wait(page, 500);

    await showLabelTimed(page, 'open-analytics', ttsMap);

    // Click sidebar parent (handles both EN "Data & Analytics" and DA "Data & Analyse" etc.)
    const dataSection = await findSidebarItem('Data & Analytics', 'Data & Analyse', 'Data og analyse');
    if (dataSection) {
      await highlight(dataSection);
      await wait(page, 1000);
      await dataSection.click();
      await wait(page, 1000);
      await unhighlight(dataSection);
    }

    await showLabelTimed(page, 'sidebar-items', ttsMap);

    // Click Data Exports sub-item (or navigate by URL as fallback)
    const dataExportsLink = await findMenuItem('Data Exports', 'Dataeksport', 'Dataeksporter');
    if (dataExportsLink) {
      await highlight(dataExportsLink);
      await showLabelTimed(page, 'click-exports', ttsMap);
      await dataExportsLink.click();
      await page.waitForLoadState('domcontentloaded');
      await wait(page, 2000);
      await unhighlight(dataExportsLink);
    } else {
      await showLabelTimed(page, 'click-exports', ttsMap);
      await page.goto(`${BASE_URL}/app/analytics/exports`);
      await page.waitForLoadState('domcontentloaded');
      await wait(page, 2000);
    }

    // ── TRIN 3: Gennemse eksportskabeloner ───────────────────────────────
    console.log('Trin 3: Gennemse eksportskabeloner');
    await showStepBadge(page, 3, 'Eksportskabeloner');
    await dismissToasts();

    await showLabelTimed(page, 'templates-list', ttsMap);
    await showLabelTimed(page, 'export-type', ttsMap);

    // ── TRIN 4: Åbn en eksportskabelon ───────────────────────────────────
    console.log('Trin 4: Åbn en eksportskabelon');
    await showStepBadge(page, 4, 'Konfigurér eksport');

    // View button — try both EN and DA
    const viewButton = page.locator('button').filter({ hasText: /^(View|Vis|Se)$/ }).first();
    if (await viewButton.isVisible().catch(() => false)) {
      await highlight(viewButton);
      await showLabelTimed(page, 'click-view', ttsMap);
      await viewButton.click();
      await unhighlight(viewButton);
      await page.waitForLoadState('domcontentloaded');
      await wait(page, 2000);
      await dismissToasts();

      await showLabelTimed(page, 'config-page', ttsMap);

      const exportBtn = page.locator('button').filter({ hasText: /[Ee]xport|[Rr]un|[Dd]ownload|[Kk]ør|[Hh]ent/ }).first();
      if (await exportBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await highlight(exportBtn);
        await showLabelTimed(page, 'run-export', ttsMap);
        await unhighlight(exportBtn);
      } else {
        await showLabelTimed(page, 'run-export-alt', ttsMap);
      }
    }

    // ── TRIN 5: Classic Exports ──────────────────────────────────────────
    console.log('Trin 5: Classic Exports — download filer');
    await showStepBadge(page, 5, 'Download din fil');

    await showLabelTimed(page, 'goto-classic', ttsMap);

    // Navigate directly by URL (reliable regardless of language)
    await page.goto(`${BASE_URL}/app/analytics/classic-exports`);
    await page.waitForLoadState('domcontentloaded');
    await wait(page, 2500);
    await dismissToasts();

    await showLabelTimed(page, 'classic-list', ttsMap);

    const xlsxLink = page.locator('td').filter({ hasText: /\.xlsx/ }).first();
    if (await xlsxLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(xlsxLink);
      await showLabelTimed(page, 'click-xlsx', ttsMap);
      await unhighlight(xlsxLink);
    }

    const csvLink = page.locator('td').filter({ hasText: /\.csv/ }).first();
    if (await csvLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await highlight(csvLink);
      await showLabelTimed(page, 'csv-note', ttsMap);
      await unhighlight(csvLink);
    }

    // ── OPSUMMERING ──────────────────────────────────────────────────────
    console.log('Trin 6: Opsummering');
    await hideStepBadge(page);

    await showLabelTimed(page, 'summary', ttsMap);

    await hideLabel(page);
    await wait(page, 1500);

  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  // Rename the video file
  const files = fs
    .readdirSync(VIDEO_DIR)
    .filter((f) => f.endsWith('.webm') && f.startsWith('page@'))
    .map((f) => ({
      name: f,
      time: fs.statSync(path.join(VIDEO_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);

  if (files.length > 0) {
    fs.renameSync(path.join(VIDEO_DIR, files[0].name), destWebm);
    console.log(`\nVideo gemt: ${destWebm}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 3 — Merge TTS audio into video
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Fase 3: Merge lyd med video ──');
  mergeAudioWithVideo(destWebm, destMp4, ttsMap);

  console.log(`\nFærdig!`);
  console.log(`  Video (uden lyd): ${destWebm}`);
  console.log(`  Video (med lyd):  ${destMp4}`);
}

main().catch((err) => {
  console.error('Optagelse fejlede:', err.message);
  process.exit(1);
});
