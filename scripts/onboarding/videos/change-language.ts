/**
 * How-To Video: Skift platformsprog (Change Language)
 *
 * Strategy: TTS-first recording
 *   Phase 1 — Pre-generate all TTS audio and get exact durations
 *   Phase 1.5 — Analyse the profile form to discover language field
 *   Phase 2 — Record video, pacing each label to match its TTS duration
 *   Phase 3 — Merge TTS audio into the video at the recorded timestamps
 *
 * Route: /app/profile/information
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
const AUDIO_DIR = path.join(VIDEO_DIR, 'tts-segments/change-language');

const VIEWPORT = { width: 2560, height: 1440 };

const ELEVENLABS_API_KEY = 'sk_d2f70907b4c1872e35a558f238d3a9c31d3b0249a3c86f49';
const ELEVENLABS_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9';

const FFMPEG_PATH = require('ffmpeg-static') as string;
const TTS_PADDING_MS = 800;

function assertNotProduction(url: string) {
  const hostname = new URL(url).hostname;
  if (!hostname.includes('development') && !hostname.includes('staging') && !hostname.includes('localhost')) {
    throw new Error(`SAFETY ABORT: "${hostname}" is not a safe environment.`);
  }
}

// ─── TTS ────────────────────────────────────────────────────────────────────

interface PregenAudio { id: string; text: string; file: string; durationMs: number; }

function getAudioDuration(filePath: string): number {
  try { execSync(`"${FFMPEG_PATH}" -i "${filePath}" 2>"${filePath}.info"`, { encoding: 'utf8', timeout: 10000 }); } catch {}
  try {
    const info = fs.readFileSync(`${filePath}.info`, 'utf8');
    fs.unlinkSync(`${filePath}.info`);
    const match = info.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (match) {
      const [, h, m, s, cs] = match;
      return Math.round((parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(cs) / 100) * 1000);
    }
  } catch {}
  const fileSize = fs.statSync(filePath).size;
  if (fileSize > 0) return Math.round((fileSize / 16000) * 1000);
  return 5000;
}

async function generateTTS(text: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      text, model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
    });
    const options = {
      hostname: 'api.elevenlabs.io', path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, method: 'POST',
      headers: { 'Accept': 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Length': Buffer.byteLength(postData) },
    };
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) { let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => reject(new Error(`ElevenLabs API ${res.statusCode}: ${body}`))); return; }
      const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { fs.writeFileSync(outputPath, Buffer.concat(chunks)); resolve(); });
    });
    req.on('error', reject); req.write(postData); req.end();
  });
}

const NARRATIONS: { id: string; text: string }[] = [
  { id: 'welcome',        text: 'Velkommen — i denne guide viser vi, hvordan du ændrer sproget på WasteHero-platformen' },
  { id: 'login-fields',   text: 'Log ind med dit brugernavn og adgangskode' },
  { id: 'dashboard',      text: 'Du er nu på Dashboardet — for at ændre sprog skal vi gå til din brugerprofil' },
  { id: 'open-profile',   text: 'Klik på dit profilikon øverst til højre for at åbne brugermenuen' },
  { id: 'click-profile',  text: 'Klik på "Profile" for at gå til dine profilindstillinger' },
  { id: 'profile-page',   text: 'Her er din profilside — du kan se dine oplysninger og indstillinger' },
  { id: 'find-language',  text: 'Find sprogfeltet — det viser dit nuværende sprog og de tilgængelige muligheder' },
  { id: 'open-dropdown',  text: 'Klik på sprogvælgeren for at se de tilgængelige sprog: dansk, engelsk, finsk, norsk og svensk' },
  { id: 'select-danish',  text: 'Vælg "Danish" for at skifte til dansk — platformen understøtter fem sprog' },
  { id: 'save-changes',   text: 'Klik på "Save" for at gemme dine ændringer' },
  { id: 'language-saved',  text: 'Sproget er nu ændret — hele brugerfladen opdateres automatisk til det nye sprog' },
  { id: 'summary',        text: 'Det var det! Du kan altid ændre sproget igen via din profilside — vælg mellem dansk, engelsk, finsk, norsk og svensk' },
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
    } catch (err: any) { console.log(` -> FEJL: ${err.message}`); }
  }
  console.log(`  Genereret: ${map.size}/${NARRATIONS.length}\n`);
  return map;
}

// ─── Recording helpers ──────────────────────────────────────────────────────

interface TimedSegment { id: string; timestampMs: number; }
const timedSegments: TimedSegment[] = [];
let videoStartTime = 0;

async function showLabelTimed(page: Page, narrationId: string, ttsMap: Map<string, PregenAudio>, position: 'bottom' | 'top' = 'bottom', minWaitMs = 2000) {
  const audio = ttsMap.get(narrationId);
  const text = audio?.text || NARRATIONS.find((n) => n.id === narrationId)?.text || narrationId;
  const ttsDuration = audio?.durationMs || 3000;
  const waitTime = Math.max(minWaitMs, ttsDuration + TTS_PADDING_MS);
  timedSegments.push({ id: narrationId, timestampMs: Date.now() - videoStartTime });
  await page.evaluate(({ label, pos }) => {
    document.querySelectorAll('.ant-notification, .ant-message, [class*="toast"], [class*="notification"]').forEach((n) => (n as HTMLElement).style.display = 'none');
    let el = document.getElementById('__vid_label');
    if (!el) { el = document.createElement('div'); el.id = '__vid_label'; document.body.appendChild(el); }
    el.style.cssText = `position:fixed;${pos === 'bottom' ? 'bottom:48px' : 'top:140px'};left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.95);color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:26px;font-weight:500;line-height:1.5;padding:20px 44px;border-radius:14px;z-index:2147483647;pointer-events:none;transition:opacity 0.35s ease;max-width:70%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.45);letter-spacing:0.2px;`;
    el.textContent = label; el.style.opacity = '1';
  }, { label: text, pos: position });
  await page.waitForTimeout(waitTime);
}

async function hideLabel(page: Page) { await page.evaluate(() => { const el = document.getElementById('__vid_label'); if (el) el.style.opacity = '0'; }); }

async function showStepBadge(page: Page, stepNum: number, title: string) {
  await page.evaluate(({ num, t }) => {
    document.querySelectorAll('.ant-notification, .ant-message, [class*="toast"]').forEach((n) => (n as HTMLElement).style.display = 'none');
    let el = document.getElementById('__vid_step');
    if (!el) { el = document.createElement('div'); el.id = '__vid_step'; document.body.appendChild(el); }
    el.style.cssText = `position:fixed;top:80px;right:40px;background:#2563eb;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:20px;font-weight:600;padding:12px 24px;border-radius:10px;z-index:2147483646;pointer-events:none;transition:opacity 0.3s ease;box-shadow:0 4px 16px rgba(37,99,235,0.4);`;
    el.innerHTML = `<span style="opacity:0.7">Trin ${num}</span> &mdash; ${t}`; el.style.opacity = '1';
  }, { num: stepNum, t: title });
}

async function hideStepBadge(page: Page) { await page.evaluate(() => { const el = document.getElementById('__vid_step'); if (el) el.style.opacity = '0'; }); }

async function highlight(locator: Locator, padding = 10) {
  try {
    const box = await locator.boundingBox(); if (!box) return;
    await locator.page().evaluate(({ x, y, w, h, pad }) => {
      let spot = document.getElementById('__vid_spotlight');
      if (!spot) { spot = document.createElement('div'); spot.id = '__vid_spotlight'; document.body.appendChild(spot); }
      spot.style.cssText = `position:fixed;top:${y - pad}px;left:${x - pad}px;width:${w + pad * 2}px;height:${h + pad * 2}px;border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,0.5);z-index:2147483645;pointer-events:none;transition:all 0.35s ease;opacity:1;`;
      const label = document.getElementById('__vid_label'); if (label) label.style.zIndex = '2147483647';
      const step = document.getElementById('__vid_step'); if (step) step.style.zIndex = '2147483647';
    }, { x: box.x, y: box.y, w: box.width, h: box.height, pad: padding });
  } catch {}
}

async function unhighlight(page: Page) {
  try { await page.evaluate(() => { const spot = document.getElementById('__vid_spotlight'); if (spot) spot.style.opacity = '0'; }); } catch {}
}

async function wait(page: Page, ms: number) { await page.waitForTimeout(ms); }

async function dismissToasts(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('.ant-notification, .ant-message, [class*="toast"], [class*="Success"], [class*="notification"]').forEach((n) => (n as HTMLElement).style.display = 'none');
  });
}

// ─── ffmpeg merge ───────────────────────────────────────────────────────────

function mergeAudioWithVideo(videoPath: string, outputPath: string, ttsMap: Map<string, PregenAudio>): void {
  const validPairs = timedSegments.map((ts) => ({ ...ts, audio: ttsMap.get(ts.id) })).filter((p): p is typeof p & { audio: PregenAudio } => !!p.audio && fs.existsSync(p.audio.file));
  if (validPairs.length === 0) { console.log('Ingen lydsegmenter — kopierer video.'); fs.copyFileSync(videoPath, outputPath); return; }
  console.log(`\nFletter ${validPairs.length} lydsegmenter med video...`);
  const inputs = validPairs.map((p) => `-i "${p.audio.file}"`).join(' ');
  const filterParts: string[] = []; const mixInputs: string[] = [];
  validPairs.forEach((pair, i) => {
    filterParts.push(`[${i + 1}:a]adelay=${pair.timestampMs}|${pair.timestampMs},aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`);
    mixInputs.push(`[a${i}]`);
  });
  const mixFilter = `${mixInputs.join('')}amix=inputs=${validPairs.length}:duration=longest:dropout_transition=2[aout]`;
  const cmd = `"${FFMPEG_PATH}" -y -i "${videoPath}" ${inputs} -filter_complex "${filterParts.join(';')};${mixFilter}" -map 0:v -map "[aout]" -c:v libx264 -crf 20 -preset fast -c:a aac -b:a 192k "${outputPath}"`;
  try { execSync(cmd, { stdio: 'pipe', timeout: 300000 }); console.log(`Video med lyd: ${outputPath}`); }
  catch (err: any) { console.error('ffmpeg fejl:', err.stderr?.toString().slice(-500) || err.message); fs.copyFileSync(videoPath, outputPath); }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  assertNotProduction(BASE_URL);
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  const destWebm = path.join(VIDEO_DIR, 'change-language.webm');
  const destMp4 = path.join(VIDEO_DIR, 'change-language.mp4');
  if (fs.existsSync(destWebm)) fs.unlinkSync(destWebm);
  if (fs.existsSync(destMp4)) fs.unlinkSync(destMp4);

  console.log('Optager: Skift platformsprog');
  console.log(`Opløsning: ${VIEWPORT.width}x${VIEWPORT.height}\n`);

  const ttsMap = await preGenerateAllTTS();

  // ── Fase 1.5: Analyse profile page ────────────────────────────────────
  console.log('── Fase 1.5: Analyserer profilside ──');
  {
    const hBrowser = await chromium.launch({ headless: true });
    const hCtx = await hBrowser.newContext({ viewport: VIEWPORT, locale: 'en-US' });
    const hPage = await hCtx.newPage();
    await hPage.goto(`${BASE_URL}/login`);
    await hPage.waitForTimeout(2000);
    await hPage.fill('input[placeholder="Username"]', EMAIL);
    await hPage.fill('input[placeholder="Password"]', PASSWORD);
    await hPage.click('button:has-text("Log in")');
    await hPage.waitForURL((url) => !url.toString().includes('/login'), { timeout: 20000 });
    await hPage.waitForTimeout(3000);

    await hPage.goto(`${BASE_URL}/app/profile/information`);
    await hPage.waitForTimeout(4000);

    const fields = await hPage.evaluate(() => {
      const items: string[] = [];
      document.querySelectorAll('.ant-form-item').forEach((fi) => {
        const label = fi.querySelector('.ant-form-item-label')?.textContent?.trim() || '';
        const hasSelect = !!fi.querySelector('.ant-select');
        const hasInput = !!fi.querySelector('input');
        const value = fi.querySelector('.ant-select-selection-item')?.textContent?.trim() ||
                      (fi.querySelector('input') as HTMLInputElement)?.value || '';
        if (label) items.push(`${label}: ${hasSelect ? 'select' : hasInput ? 'input' : 'other'} = "${value}"`);
      });
      return items;
    });
    console.log(`  Profile form fields:`);
    fields.forEach((f) => console.log(`    ${f}`));

    await hPage.close(); await hCtx.close(); await hBrowser.close();
  }
  console.log('');

  // ── Fase 2: Record video ──────────────────────────────────────────────
  console.log('── Fase 2: Optager video ──\n');

  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
    locale: 'en-US',
  });
  const page = await context.newPage();
  videoStartTime = Date.now();

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
    await wait(page, 2500);
    await dismissToasts(page);

    await showLabelTimed(page, 'dashboard', ttsMap);

    // ── TRIN 2: Åbn brugerprofil ────────────────────────────────────────
    console.log('Trin 2: Åbn brugerprofil');
    await hideLabel(page);
    await showStepBadge(page, 2, 'Brugerprofil');

    // Try to find the user avatar/menu in the header (top-right)
    const userMenu = page.locator('[data-testid="user-menu"], .ant-avatar, header .ant-dropdown-trigger, header img[alt]').first();
    if (await userMenu.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(userMenu);
      await showLabelTimed(page, 'open-profile', ttsMap);
      await userMenu.click();
      await wait(page, 1500);
      await unhighlight(page);

      // Look for profile link in dropdown
      const profileLink = page.locator('a, [role="menuitem"], .ant-dropdown-menu-item').filter({
        hasText: /Profile|Profil|My Profile|Min profil/i,
      }).first();
      if (await profileLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        await highlight(profileLink);
        await showLabelTimed(page, 'click-profile', ttsMap);
        await profileLink.click();
        await unhighlight(page);
        await page.waitForLoadState('domcontentloaded');
        await wait(page, 3000);
      } else {
        // Fallback: navigate directly
        await showLabelTimed(page, 'click-profile', ttsMap);
        await page.goto(`${BASE_URL}/app/profile/information`);
        await page.waitForLoadState('domcontentloaded');
        await wait(page, 3000);
      }
    } else {
      // Fallback: navigate directly to profile
      await showLabelTimed(page, 'open-profile', ttsMap);
      await page.goto(`${BASE_URL}/app/profile/information`);
      await page.waitForLoadState('domcontentloaded');
      await wait(page, 3000);
      await showLabelTimed(page, 'click-profile', ttsMap);
    }

    await dismissToasts(page);

    // ── TRIN 3: Find sprog-felt ─────────────────────────────────────────
    console.log('Trin 3: Find sprogindstilling');
    await showStepBadge(page, 3, 'Sprogindstilling');

    await showLabelTimed(page, 'profile-page', ttsMap);

    // Find Language form item
    const langFormItem = page.locator('.ant-form-item').filter({
      hasText: /Language|Sprog|Sprache/i,
    }).first();

    // Fallback: find by current value containing a known language
    let langItem = langFormItem;
    if (!await langItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      langItem = page.locator('.ant-form-item').filter({
        has: page.locator('.ant-select-selection-item', { hasText: /English|Danish|Norwegian|Finnish|Swedish|Dansk|Engelsk/ }),
      }).first();
    }

    // Scroll to make it visible if needed
    if (!await langItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await wait(page, 1000);
    }

    if (await langItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(langItem, 15);
      await showLabelTimed(page, 'find-language', ttsMap);
      await unhighlight(page);

      // ── TRIN 4: Åbn dropdown og vælg dansk ────────────────────────────
      console.log('Trin 4: Skift sprog til dansk');
      await showStepBadge(page, 4, 'Vælg dansk');

      const langSelect = langItem.locator('.ant-select').first();
      await highlight(langSelect);
      await showLabelTimed(page, 'open-dropdown', ttsMap);
      await langSelect.click();
      await wait(page, 1500);
      await unhighlight(page);

      // Find Danish option in dropdown portal
      const dropdown = page.locator('.ant-select-dropdown:visible').last();
      const danishOption = dropdown.locator('.ant-select-item-option', { hasText: /Danish|Dansk/ }).first();
      let foundDanish = await danishOption.isVisible({ timeout: 2000 }).catch(() => false);

      if (!foundDanish) {
        // Try broader search
        const altOption = dropdown.locator('.ant-select-item-option-content', { hasText: /Danish|Dansk/ }).first();
        foundDanish = await altOption.isVisible({ timeout: 2000 }).catch(() => false);
        if (foundDanish) {
          await highlight(altOption);
          await showLabelTimed(page, 'select-danish', ttsMap);
          await altOption.click();
          await unhighlight(page);
        }
      } else {
        await highlight(danishOption);
        await showLabelTimed(page, 'select-danish', ttsMap);
        await danishOption.click();
        await unhighlight(page);
      }

      if (!foundDanish) {
        // Pick any available option for demo purposes
        const anyOption = dropdown.locator('.ant-select-item-option').first();
        if (await anyOption.isVisible({ timeout: 2000 }).catch(() => false)) {
          await highlight(anyOption);
          await showLabelTimed(page, 'select-danish', ttsMap);
          await anyOption.click();
          await unhighlight(page);
        } else {
          await page.keyboard.press('Escape');
          await showLabelTimed(page, 'select-danish', ttsMap);
        }
      }

      await wait(page, 800);

      // ── TRIN 5: Gem ændringer ─────────────────────────────────────────
      console.log('Trin 5: Gem ændringer');
      await showStepBadge(page, 5, 'Gem');

      const saveBtn = page.locator('button[type="submit"], button').filter({
        hasText: /^Save$|^Update$|^Gem$|^Opdater$|^Submit$/i,
      }).first();

      if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await highlight(saveBtn);
        await showLabelTimed(page, 'save-changes', ttsMap);
        await saveBtn.click();
        await unhighlight(page);

        await wait(page, 4000);
        await dismissToasts(page);
      } else {
        await showLabelTimed(page, 'save-changes', ttsMap);
      }

      await showLabelTimed(page, 'language-saved', ttsMap);

    } else {
      console.log('  [warn] Language field not found on profile page');
      await showLabelTimed(page, 'find-language', ttsMap);
      await showLabelTimed(page, 'open-dropdown', ttsMap);
      await showLabelTimed(page, 'select-danish', ttsMap);
      await showLabelTimed(page, 'save-changes', ttsMap);
      await showLabelTimed(page, 'language-saved', ttsMap);
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

  // Rename video
  const files = fs.readdirSync(VIDEO_DIR)
    .filter((f) => f.endsWith('.webm') && f.startsWith('page@'))
    .map((f) => ({ name: f, time: fs.statSync(path.join(VIDEO_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  if (files.length > 0) {
    fs.renameSync(path.join(VIDEO_DIR, files[0].name), destWebm);
    console.log(`\nVideo gemt: ${destWebm}`);
  }

  console.log('\n── Fase 3: Merge lyd med video ──');
  mergeAudioWithVideo(destWebm, destMp4, ttsMap);

  console.log(`\nFærdig!`);
  console.log(`  Video (uden lyd): ${destWebm}`);
  console.log(`  Video (med lyd):  ${destMp4}`);
}

main().catch((err) => { console.error('Optagelse fejlede:', err.message); process.exit(1); });
