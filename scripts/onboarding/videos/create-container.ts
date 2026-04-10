/**
 * How-To Video: Opret en container (Create a Container)
 *
 * Strategy: TTS-first recording
 *   Phase 1 — Pre-generate all TTS audio and get exact durations
 *   Phase 1.5 — Analyse the create form (headless) to discover all fields
 *   Phase 2 — Record video, pacing each label to match its TTS duration
 *   Phase 3 — Merge TTS audio into the video at the recorded timestamps
 *
 * Route: /app/asset-management/containers → /app/asset-management/containers/create
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
const AUDIO_DIR = path.join(VIDEO_DIR, 'tts-segments/create-container');

const VIEWPORT = { width: 2560, height: 1440 };

// ElevenLabs TTS config
const ELEVENLABS_API_KEY = 'sk_d2f70907b4c1872e35a558f238d3a9c31d3b0249a3c86f49';
const ELEVENLABS_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // Daniel - premade, free tier, Danish

const FFMPEG_PATH = require('ffmpeg-static') as string;

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
  try {
    execSync(`"${FFMPEG_PATH}" -i "${filePath}" 2>"${filePath}.info"`, {
      encoding: 'utf8',
      timeout: 10000,
    });
  } catch {}

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

  const fileSize = fs.statSync(filePath).size;
  if (fileSize > 0) return Math.round((fileSize / 16000) * 1000);
  return 5000;
}

async function generateTTS(text: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
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

const NARRATIONS: { id: string; text: string }[] = [
  { id: 'welcome',          text: 'Velkommen til WasteHero — i denne guide viser vi, hvordan du opretter en ny container i systemet' },
  { id: 'login-fields',     text: 'Indtast dit brugernavn og adgangskode, og klik derefter på "Log ind"' },
  { id: 'dashboard',        text: 'Du er nu på Dashboardet — herfra navigerer vi til containerstyring' },
  { id: 'open-assets',      text: 'Åbn sektionen "Assets" i venstre sidepanel for at se dine containere og grupper' },
  { id: 'sidebar-items',    text: 'Sidepanelet viser: Containers, Map View og Groups — klik på "Containers"' },
  { id: 'click-containers', text: 'Her ser du en oversigt over alle registrerede containere med deres type, status og placering' },
  { id: 'click-create',     text: 'Klik på "Add container" knappen for at oprette en ny container' },
  { id: 'create-form',      text: 'Formularen har flere sektioner — vi starter med de grundlæggende oplysninger øverst' },
  { id: 'fill-id',          text: 'Indtast et container-ID — dette bruges som reference i hele systemet' },
  { id: 'fill-project',     text: 'Vælg det projekt, containeren tilhører — dette er et påkrævet felt' },
  { id: 'fill-type',        text: 'Vælg containertype — for eksempel underjordisk, overflade eller minicontainer' },
  { id: 'fill-waste',       text: 'Vælg affaldsfraktion — dette angiver, hvilken type affald containeren er beregnet til' },
  { id: 'fill-pickup',      text: 'Nu udfylder vi afhentningsindstillingerne — vælg afhentningsmetode, status og indstilling' },
  { id: 'fill-calendar',    text: 'Vælg en afhentningskalender, der bestemmer, hvornår containeren tømmes' },
  { id: 'save-container',   text: 'Alle påkrævede felter er nu udfyldt — klik på "Create" for at oprette containeren' },
  { id: 'container-saved',  text: 'Containeren er nu oprettet og vises i listen — du kan klikke på den for at se detaljer eller redigere' },
  { id: 'summary',          text: 'Det var det! Brug "Assets" og "Containers" i sidepanelet til at oprette og administrere dine containere i WasteHero' },
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

interface TimedSegment { id: string; timestampMs: number; }
const timedSegments: TimedSegment[] = [];
let videoStartTime = 0;

async function showLabelTimed(
  page: Page, narrationId: string, ttsMap: Map<string, PregenAudio>,
  position: 'bottom' | 'top' = 'bottom', minWaitMs = 2000,
) {
  const audio = ttsMap.get(narrationId);
  const text = audio?.text || NARRATIONS.find((n) => n.id === narrationId)?.text || narrationId;
  const ttsDuration = audio?.durationMs || 3000;
  const waitTime = Math.max(minWaitMs, ttsDuration + TTS_PADDING_MS);

  timedSegments.push({ id: narrationId, timestampMs: Date.now() - videoStartTime });

  await page.evaluate(
    ({ label, pos }) => {
      document.querySelectorAll('.ant-notification, .ant-message, [class*="toast"], [class*="notification"]').forEach(
        (n) => (n as HTMLElement).style.display = 'none'
      );
      let el = document.getElementById('__vid_label');
      if (!el) { el = document.createElement('div'); el.id = '__vid_label'; document.body.appendChild(el); }
      el.style.cssText = `
        position: fixed; ${pos === 'bottom' ? 'bottom: 48px' : 'top: 140px'};
        left: 50%; transform: translateX(-50%);
        background: rgba(15, 23, 42, 0.95); color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 26px; font-weight: 500; line-height: 1.5;
        padding: 20px 44px; border-radius: 14px;
        z-index: 2147483647; pointer-events: none;
        transition: opacity 0.35s ease;
        max-width: 70%; text-align: center;
        box-shadow: 0 8px 32px rgba(0,0,0,0.45); letter-spacing: 0.2px;
      `;
      el.textContent = label;
      el.style.opacity = '1';
    },
    { label: text, pos: position }
  );
  await page.waitForTimeout(waitTime);
}

async function hideLabel(page: Page) {
  await page.evaluate(() => { const el = document.getElementById('__vid_label'); if (el) el.style.opacity = '0'; });
}

async function showStepBadge(page: Page, stepNum: number, title: string) {
  await page.evaluate(
    ({ num, t }) => {
      document.querySelectorAll('.ant-notification, .ant-message, [class*="toast"]').forEach(
        (n) => (n as HTMLElement).style.display = 'none'
      );
      let el = document.getElementById('__vid_step');
      if (!el) { el = document.createElement('div'); el.id = '__vid_step'; document.body.appendChild(el); }
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
  await page.evaluate(() => { const el = document.getElementById('__vid_step'); if (el) el.style.opacity = '0'; });
}

async function highlight(locator: Locator, padding = 10) {
  try {
    const box = await locator.boundingBox();
    if (!box) return;
    await locator.page().evaluate(
      ({ x, y, w, h, pad }) => {
        let spot = document.getElementById('__vid_spotlight');
        if (!spot) { spot = document.createElement('div'); spot.id = '__vid_spotlight'; document.body.appendChild(spot); }
        spot.style.cssText = `
          position: fixed; top: ${y - pad}px; left: ${x - pad}px;
          width: ${w + pad * 2}px; height: ${h + pad * 2}px;
          border-radius: 10px; box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
          z-index: 2147483645; pointer-events: none;
          transition: all 0.35s ease; opacity: 1;
        `;
        const label = document.getElementById('__vid_label');
        if (label) label.style.zIndex = '2147483647';
        const step = document.getElementById('__vid_step');
        if (step) step.style.zIndex = '2147483647';
      },
      { x: box.x, y: box.y, w: box.width, h: box.height, pad: padding }
    );
  } catch {}
}

async function unhighlight(page: Page) {
  try {
    await page.evaluate(() => { const spot = document.getElementById('__vid_spotlight'); if (spot) spot.style.opacity = '0'; });
  } catch {}
}

async function wait(page: Page, ms: number) { await page.waitForTimeout(ms); }

async function dismissToasts(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('.ant-notification, .ant-message, [class*="toast"], [class*="Success"], [class*="notification"]').forEach(
      (n) => (n as HTMLElement).style.display = 'none'
    );
  });
}

// ─── Form helpers ───────────────────────────────────────────────────────────

/** Analyse all form items on the page — returns labels, types, required status */
async function analyseFormFields(page: Page) {
  return page.evaluate(() => {
    const fields: Array<{
      label: string;
      type: 'input' | 'select' | 'number' | 'checkbox' | 'textarea' | 'unknown';
      required: boolean;
      hasValue: boolean;
    }> = [];

    document.querySelectorAll('.ant-form-item').forEach((fi) => {
      const labelEl = fi.querySelector('.ant-form-item-label label, .ant-form-item-label');
      const label = labelEl?.textContent?.trim().replace(/\s*\*$/, '') || '';
      if (!label) return;

      const required = !!fi.querySelector('.ant-form-item-required') ||
                       !!fi.querySelector('.ant-form-item-explain-error');
      const hasSelect = !!fi.querySelector('.ant-select');
      const hasInput = !!fi.querySelector('input:not([type="hidden"]):not([readonly])');
      const hasNumber = !!fi.querySelector('.ant-input-number');
      const hasCheckbox = !!fi.querySelector('.ant-checkbox, .ant-switch');
      const hasTextarea = !!fi.querySelector('textarea');

      const selectValue = fi.querySelector('.ant-select-selection-item')?.textContent?.trim() || '';
      const inputValue = (fi.querySelector('input:not([type="hidden"])') as HTMLInputElement)?.value || '';
      const hasValue = !!(selectValue || inputValue);

      let type: typeof fields[0]['type'] = 'unknown';
      if (hasSelect) type = 'select';
      else if (hasNumber) type = 'number';
      else if (hasTextarea) type = 'textarea';
      else if (hasCheckbox) type = 'checkbox';
      else if (hasInput) type = 'input';

      fields.push({ label, type, required, hasValue });
    });
    return fields;
  });
}

/** Click an Ant Select, wait for dropdown, pick the first option */
async function pickFirstSelectOption(page: Page, formItemLocator: Locator, label: string): Promise<boolean> {
  const select = formItemLocator.locator('.ant-select').first();
  if (!await select.isVisible({ timeout: 2000 }).catch(() => false)) return false;

  await select.click();
  await wait(page, 1200);

  const dropdown = page.locator('.ant-select-dropdown:visible').last();
  const option = dropdown.locator('.ant-select-item-option').first();
  if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
    await option.click();
    await wait(page, 600);
    console.log(`    [fill] ${label}: picked first option`);
    return true;
  } else {
    await page.keyboard.press('Escape');
    console.log(`    [fill] ${label}: no options available`);
    return false;
  }
}

/** Find a form item by label patterns (supports EN/DA) */
function findFormItem(page: Page, ...patterns: string[]): Locator {
  const combined = patterns.join('|');
  return page.locator('.ant-form-item').filter({
    hasText: new RegExp(combined, 'i'),
  }).first();
}

// ─── ffmpeg merge ───────────────────────────────────────────────────────────

function mergeAudioWithVideo(videoPath: string, outputPath: string, ttsMap: Map<string, PregenAudio>): void {
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
    filterParts.push(
      `[${i + 1}:a]adelay=${pair.timestampMs}|${pair.timestampMs},aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`
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

  const destWebm = path.join(VIDEO_DIR, 'create-container.webm');
  const destMp4 = path.join(VIDEO_DIR, 'create-container.mp4');
  if (fs.existsSync(destWebm)) fs.unlinkSync(destWebm);
  if (fs.existsSync(destMp4)) fs.unlinkSync(destMp4);

  console.log('Optager: Opret en container');
  console.log(`Opløsning: ${VIEWPORT.width}x${VIEWPORT.height}`);
  console.log('TTS: ElevenLabs (dansk)\n');

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 1 — Pre-generér TTS
  // ══════════════════════════════════════════════════════════════════════════
  const ttsMap = await preGenerateAllTTS();

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 1.5 — Pre-flight: set language to Danish + analyse form (headless)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── Fase 1.5: Sætter sprog til dansk + analyserer formularen ──');
  {
    // NOTE: headless: false is required — Ant Design Select dropdown portals
    // do not render in headless Chromium (virtual list never mounts).
    const hBrowser = await chromium.launch({ headless: false });
    const hCtx = await hBrowser.newContext({ viewport: VIEWPORT, locale: 'da-DK' });
    const hPage = await hCtx.newPage();

    await hPage.goto(`${BASE_URL}/login`);
    await hPage.waitForTimeout(2000);
    await hPage.fill('input[placeholder="Username"]', EMAIL);
    await hPage.fill('input[placeholder="Password"]', PASSWORD);
    await hPage.click('button:has-text("Log in")');
    await hPage.waitForURL((url) => !url.toString().includes('/login'), { timeout: 20000 });
    await hPage.waitForTimeout(3000);

    // ── Set language to Danish via profile page ──
    // The profile page loads in READ-ONLY mode. Must click "Edit" first.
    console.log('  [lang] Navigerer til profil...');
    await hPage.goto(`${BASE_URL}/app/profile/information`);
    await hPage.waitForTimeout(4000);

    // Step 1: Click "Edit" button (bottom-right) to enter edit mode
    const editBtn = hPage.locator('button').filter({ hasText: /Edit|Rediger/i }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('  [lang] Klikker "Edit" for at aktivere redigering...');
      await editBtn.click();
      await hPage.waitForTimeout(2000);
    } else {
      console.log('  [lang] "Edit" knap ikke fundet — prøver at fortsætte.');
    }

    // Step 2: Click "Preference" in the setting menu to scroll to language section
    const prefLink = hPage.locator('a, div, span').filter({ hasText: /^Preference$/i }).first();
    if (await prefLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await prefLink.click();
      await hPage.waitForTimeout(1000);
    }

    // Step 3: Find the Language form item (now editable as a Select)
    const langItem = hPage.locator('.ant-form-item').filter({
      hasText: /Language|Sprog/i,
    }).first();

    if (await langItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Check current value
      const currentLang = await langItem.locator('.ant-select-selection-item').textContent().catch(() => '') ||
                          await langItem.evaluate((el) => el.textContent?.match(/English|Danish|Dansk|Norwegian|Finnish|Swedish/i)?.[0] || '');
      console.log(`  [lang] Nuværende sprog: "${currentLang}"`);

      if (currentLang?.match(/Danish|Dansk/i)) {
        console.log('  [lang] Allerede dansk — springer over.');
      } else {
        // Click the select to open the dropdown
        const langSelect = langItem.locator('.ant-select').first();
        if (await langSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
          await langSelect.click();
          await hPage.waitForTimeout(1500);

          // Debug: check what dropdowns exist
          const ddCount = await hPage.locator('.ant-select-dropdown').count();
          console.log(`  [lang] Dropdowns efter klik: ${ddCount}`);

          // Find and click Danish option
          let found = false;
          const dropdown = hPage.locator('.ant-select-dropdown:visible').last();
          const danishOpt = dropdown.locator('.ant-select-item-option', { hasText: /Danish|Dansk/ }).first();

          if (await danishOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
            await danishOpt.click();
            found = true;
            console.log('  [lang] Valgte dansk.');
          }

          // Fallback: try all dropdowns
          if (!found) {
            const allDropdowns = hPage.locator('.ant-select-dropdown');
            for (let i = (await allDropdowns.count()) - 1; i >= 0 && !found; i--) {
              const dd = allDropdowns.nth(i);
              const opt = dd.locator('.ant-select-item').filter({ hasText: /Danish|Dansk/ }).first();
              if (await opt.isVisible({ timeout: 1000 }).catch(() => false)) {
                await opt.click();
                found = true;
                console.log('  [lang] Valgte dansk (fallback dropdown).');
              }
            }
          }

          // Fallback: click via evaluate
          if (!found) {
            const clicked = await hPage.evaluate(() => {
              const items = document.querySelectorAll('.ant-select-item-option, .ant-select-item');
              for (const item of items) {
                if (/Danish|Dansk/i.test(item.textContent || '')) {
                  (item as HTMLElement).click();
                  return item.textContent?.trim();
                }
              }
              return null;
            });
            if (clicked) {
              found = true;
              console.log(`  [lang] Valgte "${clicked}" (via evaluate).`);
            }
          }

          if (!found) {
            await hPage.keyboard.press('Escape');
            console.log('  [lang] Danish option ikke fundet.');
          }

          await hPage.waitForTimeout(800);

          if (found) {
            // Save — after editing, the button changes to Save/Update
            const saveBtn = hPage.locator('button[type="submit"], button').filter({
              hasText: /^Save$|^Update$|^Gem$|^Opdater$/i,
            }).first();
            if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await saveBtn.click();
              await hPage.waitForTimeout(4000);
              console.log('  [lang] Gemt — sproget er nu dansk.');
            } else {
              console.log('  [lang] Gem-knap ikke fundet.');
            }
          }
        } else {
          console.log('  [lang] Sprogfeltet er ikke et Select-element (stadig i visnings-tilstand?).');
        }
      }
    } else {
      console.log('  [lang] Sprogfelt ikke fundet på profilsiden.');
    }

    // ── Now analyse the create-container form ──
    console.log('  [form] Analyserer container-formularen...');
    await hPage.goto(`${BASE_URL}/app/asset-management/containers/create`);
    await hPage.waitForTimeout(4000);

    // Scroll the whole page to make sure lazy sections load
    await hPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await hPage.waitForTimeout(1000);
    await hPage.evaluate(() => window.scrollTo(0, 0));
    await hPage.waitForTimeout(500);

    const fields = await analyseFormFields(hPage);
    console.log(`  Found ${fields.length} form fields:`);
    fields.forEach((f) => {
      const req = f.required ? ' [REQUIRED]' : '';
      const val = f.hasValue ? ' (has value)' : '';
      console.log(`    ${f.label} — ${f.type}${req}${val}`);
    });

    await hPage.close();
    await hCtx.close();
    await hBrowser.close();
  }
  console.log('');

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
    await showLabelTimed(page, 'login-fields', ttsMap);
    await emailInput.fill(EMAIL);
    await wait(page, 500);
    await unhighlight(page);

    const passInput = page.locator('input[placeholder="Password"]');
    await highlight(passInput);
    await wait(page, 400);
    await passInput.fill(PASSWORD);
    await wait(page, 500);
    await unhighlight(page);

    const loginBtn = page.locator('button:has-text("Log in")');
    await highlight(loginBtn);
    await wait(page, 600);
    await loginBtn.click();
    await unhighlight(page);

    await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 20000 });
    await page.waitForLoadState('domcontentloaded');
    await wait(page, 2000);
    await dismissToasts(page);
    await wait(page, 500);

    await showLabelTimed(page, 'dashboard', ttsMap);

    // ── TRIN 2: Naviger til Assets > Containers ─────────────────────────
    console.log('Trin 2: Naviger til Assets > Containers');
    await hideLabel(page);
    await showStepBadge(page, 2, 'Naviger til Containers');
    await wait(page, 500);

    await showLabelTimed(page, 'open-assets', ttsMap);

    const assetsSection = await findSidebarItem('Assets', 'Aktiver', 'Beholdere');
    if (assetsSection) {
      await highlight(assetsSection);
      await wait(page, 1000);
      await assetsSection.click();
      await wait(page, 1000);
      await unhighlight(page);
    }

    await showLabelTimed(page, 'sidebar-items', ttsMap);

    const containersLink = await findMenuItem('Containers', 'Containere', 'Beholdere');
    if (containersLink) {
      await highlight(containersLink);
      await wait(page, 800);
      await containersLink.click();
      await page.waitForLoadState('domcontentloaded');
      await wait(page, 2000);
      await unhighlight(page);
    } else {
      await page.goto(`${BASE_URL}/app/asset-management/containers`);
      await page.waitForLoadState('domcontentloaded');
      await wait(page, 2000);
    }

    // ── TRIN 3: Container liste ─────────────────────────────────────────
    console.log('Trin 3: Container oversigt');
    await showStepBadge(page, 3, 'Container oversigt');
    await dismissToasts(page);

    await showLabelTimed(page, 'click-containers', ttsMap);

    // ── TRIN 4: Klik "Opret container" ──────────────────────────────────
    console.log('Trin 4: Opret ny container');
    await showStepBadge(page, 4, 'Opret container');

    const addBtn = page.locator('button, a').filter({
      hasText: /Add container|Tilføj container|New container|Ny container/i,
    }).first();

    let clickedCreate = false;
    if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(addBtn);
      await showLabelTimed(page, 'click-create', ttsMap);
      await addBtn.click();
      await unhighlight(page);
      clickedCreate = true;
    } else {
      // Try Action dropdown
      const actionDropdown = page.locator('button').filter({ hasText: /Action|Handling/i }).first();
      if (await actionDropdown.isVisible({ timeout: 2000 }).catch(() => false)) {
        await highlight(actionDropdown);
        await wait(page, 500);
        await actionDropdown.click();
        await wait(page, 1000);
        await unhighlight(page);

        const addOption = page.locator('.ant-dropdown-menu-item, [role="menuitem"]').filter({
          hasText: /Add container|Tilføj container|Create|Opret/i,
        }).first();
        if (await addOption.isVisible({ timeout: 2000 }).catch(() => false)) {
          await highlight(addOption);
          await showLabelTimed(page, 'click-create', ttsMap);
          await addOption.click();
          await unhighlight(page);
          clickedCreate = true;
        }
      }
    }

    if (!clickedCreate) {
      await showLabelTimed(page, 'click-create', ttsMap);
      await page.goto(`${BASE_URL}/app/asset-management/containers/create`);
    }

    await page.waitForLoadState('domcontentloaded');
    await wait(page, 3000);
    await dismissToasts(page);

    // ── TRIN 5: Udfyld formularen ───────────────────────────────────────
    console.log('Trin 5: Udfyld container-formularen');
    await showStepBadge(page, 5, 'Udfyld formularen');

    // Log what we see on this page
    const liveFields = await analyseFormFields(page);
    console.log(`  Live form fields (${liveFields.length}):`);
    liveFields.forEach((f) => console.log(`    ${f.label} — ${f.type}${f.required ? ' [REQ]' : ''}`));

    await showLabelTimed(page, 'create-form', ttsMap);

    // --- 5a: Container ID (text input in top row) ---
    const idItem = findFormItem(page, 'Container ID', 'Container-ID');
    const idInput = idItem.locator('input:not([readonly])').first();
    if (await idInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await highlight(idInput);
      await showLabelTimed(page, 'fill-id', ttsMap);
      await idInput.click();
      await idInput.fill('DEMO-CTR-001');
      await wait(page, 800);
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'fill-id', ttsMap);
    }

    // --- 5b: Project (required select) ---
    const projectItem = findFormItem(page, '^Project$', '^Projekt$');
    if (await projectItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await highlight(projectItem);
      await showLabelTimed(page, 'fill-project', ttsMap);
      await pickFirstSelectOption(page, projectItem, 'Project');
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'fill-project', ttsMap);
    }

    // --- 5c: Container type (required select) ---
    const typeItem = findFormItem(page, 'Container type', 'Containertype');
    if (await typeItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await highlight(typeItem);
      await showLabelTimed(page, 'fill-type', ttsMap);
      await pickFirstSelectOption(page, typeItem, 'Container type');
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'fill-type', ttsMap);
    }

    // --- 5d: Waste fraction (required select) ---
    const wasteItem = findFormItem(page, 'Waste fraction', 'Waste Fraction', 'Affaldsfraktion');
    if (await wasteItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await highlight(wasteItem);
      await showLabelTimed(page, 'fill-waste', ttsMap);
      await pickFirstSelectOption(page, wasteItem, 'Waste fraction');
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'fill-waste', ttsMap);
    }

    // --- 5e: Scroll to Pickup settings section ---
    // Click "Pickup settings" in the left setting menu if visible
    const pickupMenuLink = page.locator('a, div, span').filter({ hasText: /^Pickup settings$/i }).first();
    if (await pickupMenuLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await pickupMenuLink.click();
      await wait(page, 1000);
    } else {
      await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'smooth' }));
      await wait(page, 1000);
    }

    console.log('  Udfylder Pickup settings...');
    await showLabelTimed(page, 'fill-pickup', ttsMap);

    // Pickup method (required select)
    const pickupMethodItem = findFormItem(page, 'Pickup method', 'Afhentningsmetode');
    if (await pickupMethodItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(pickupMethodItem);
      await pickFirstSelectOption(page, pickupMethodItem, 'Pickup method');
      await wait(page, 400);
      await unhighlight(page);
    }

    // Status (required select)
    const statusItem = findFormItem(page, '^Status$');
    if (await statusItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(statusItem);
      await pickFirstSelectOption(page, statusItem, 'Status');
      await wait(page, 400);
      await unhighlight(page);
    }

    // Pickup setting (required select)
    const pickupSettingItem = findFormItem(page, 'Pickup setting', 'Afhentningsindstilling');
    if (await pickupSettingItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(pickupSettingItem);
      await pickFirstSelectOption(page, pickupSettingItem, 'Pickup setting');
      await wait(page, 400);
      await unhighlight(page);
    }

    // Collection calendar (required select)
    const calendarItem = findFormItem(page, 'Collection calendar', 'Afhentningskalender', 'Tømningskalender');
    if (await calendarItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(calendarItem);
      await showLabelTimed(page, 'fill-calendar', ttsMap);
      await pickFirstSelectOption(page, calendarItem, 'Collection calendar');
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'fill-calendar', ttsMap);
    }

    // --- 5f: Fill any remaining required fields we may have missed ---
    // Re-scan for unfilled required fields and try to fill them
    const remainingFields = await analyseFormFields(page);
    const unfilled = remainingFields.filter((f) => f.required && !f.hasValue);
    if (unfilled.length > 0) {
      console.log(`  [auto-fill] ${unfilled.length} required fields still empty:`);
      for (const field of unfilled) {
        console.log(`    Attempting: ${field.label} (${field.type})`);
        const item = page.locator('.ant-form-item').filter({ hasText: field.label }).first();
        if (field.type === 'select') {
          await pickFirstSelectOption(page, item, field.label);
        } else if (field.type === 'input') {
          const inp = item.locator('input:not([readonly])').first();
          if (await inp.isVisible({ timeout: 1500 }).catch(() => false)) {
            await inp.click();
            await inp.fill('Demo');
            await wait(page, 300);
          }
        } else if (field.type === 'number') {
          const inp = item.locator('.ant-input-number input, input').first();
          if (await inp.isVisible({ timeout: 1500 }).catch(() => false)) {
            await inp.click();
            await inp.fill('1');
            await wait(page, 300);
          }
        }
      }
    }

    // Scroll back to top
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await wait(page, 1000);

    // ── TRIN 6: Gem containeren ─────────────────────────────────────────
    console.log('Trin 6: Gem containeren');
    await showStepBadge(page, 6, 'Gem');

    const saveBtn = page.locator('button[type="submit"], button').filter({
      hasText: /^Create$|^Save$|^Gem$|^Opret$/i,
    }).first();

    if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(saveBtn);
      await showLabelTimed(page, 'save-container', ttsMap);
      await saveBtn.click();
      await unhighlight(page);

      await page.waitForLoadState('domcontentloaded');
      await wait(page, 4000);
      await dismissToasts(page);

      // Check if submit succeeded (navigated away from /create)
      const stillOnCreate = page.url().includes('/create');
      if (stillOnCreate) {
        console.log('  [warn] Still on create page — validation errors remain:');
        const errors = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.ant-form-item-explain-error'))
            .map((e) => e.textContent?.trim()).filter(Boolean)
        );
        errors.forEach((e) => console.log(`    - ${e}`));
      } else {
        console.log('  Container created successfully!');
      }
    } else {
      await showLabelTimed(page, 'save-container', ttsMap);
    }

    await showLabelTimed(page, 'container-saved', ttsMap);

    // ── OPSUMMERING ──────────────────────────────────────────────────────
    console.log('Trin 7: Opsummering');
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
    .map((f) => ({ name: f, time: fs.statSync(path.join(VIDEO_DIR, f)).mtimeMs }))
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
