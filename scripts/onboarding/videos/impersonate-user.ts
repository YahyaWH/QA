/**
 * How-To Video: Impersonér en bruger (Impersonate a User)
 *
 * Strategy: TTS-first recording
 *   Phase 1 — Pre-generate all TTS audio and get exact durations
 *   Phase 1.5 — Analyse the Control Center to discover impersonation UI
 *   Phase 2 — Record video, pacing each label to match its TTS duration
 *   Phase 3 — Merge TTS audio into the video at the recorded timestamps
 *
 * Route: /app/control-center/* (WasteHero staff only)
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
const AUDIO_DIR = path.join(VIDEO_DIR, 'tts-segments/impersonate-user');

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
  { id: 'welcome',           text: 'Velkommen — i denne guide viser vi, hvordan WasteHero-medarbejdere kan impersonere en bruger for at fejlfinde og hjælpe kunder' },
  { id: 'login-fields',      text: 'Log ind med din WasteHero-medarbejderkonto — impersonering kræver staff-adgang' },
  { id: 'dashboard',         text: 'Du er nu logget ind — lad os navigere til Control Center, hvor impersonering styres' },
  { id: 'open-control',      text: 'Åbn Control Center fra navigationen — dette er kun synligt for WasteHero-medarbejdere' },
  { id: 'control-center',    text: 'Control Center giver adgang til virksomheder, brugere og systemindstillinger på tværs af alle kunder' },
  { id: 'find-company',      text: 'Find den virksomhed eller bruger, du vil impersonere — brug søgefeltet til at filtrere' },
  { id: 'click-impersonate', text: 'Klik på "Impersonate" knappen for at logge ind som den valgte bruger' },
  { id: 'impersonating',     text: 'Du er nu logget ind som den valgte bruger — bemærk indikatoren øverst, der viser, at du impersonerer' },
  { id: 'see-as-user',       text: 'Nu kan du se platformen præcis som brugeren ser den — dette er nyttigt til fejlfinding og support' },
  { id: 'stop-impersonate',  text: 'For at stoppe impersonering, klik på "Stop impersonating" knappen eller banneret øverst' },
  { id: 'back-to-staff',     text: 'Du er nu tilbage som din egen medarbejderkonto — alle ændringer foretaget under impersonering er gemt' },
  { id: 'summary',           text: 'Det var det! Brug Control Center til at impersonere brugere, når du skal fejlfinde eller hjælpe kunder — husk altid at stoppe impersonering, når du er færdig' },
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

  const destWebm = path.join(VIDEO_DIR, 'impersonate-user.webm');
  const destMp4 = path.join(VIDEO_DIR, 'impersonate-user.mp4');
  if (fs.existsSync(destWebm)) fs.unlinkSync(destWebm);
  if (fs.existsSync(destMp4)) fs.unlinkSync(destMp4);

  console.log('Optager: Impersonér en bruger');
  console.log(`Opløsning: ${VIEWPORT.width}x${VIEWPORT.height}\n`);

  const ttsMap = await preGenerateAllTTS();

  // ── Fase 1.5: Analyse Control Center ──────────────────────────────────
  console.log('── Fase 1.5: Analyserer Control Center ──');
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

    // Try navigating to control center
    await hPage.goto(`${BASE_URL}/app/control-center`);
    await hPage.waitForTimeout(4000);

    const pageContent = await hPage.evaluate(() => {
      const elements: string[] = [];
      // Look for any interactive elements, tables, buttons
      document.querySelectorAll('button, a, [role="tab"], .ant-table, .ant-card, h1, h2, h3, h4').forEach((el) => {
        const text = el.textContent?.trim().substring(0, 100) || '';
        const tag = el.tagName.toLowerCase();
        const href = (el as HTMLAnchorElement).href || '';
        if (text) elements.push(`<${tag}${href ? ` href="${href}"` : ''}> ${text}`);
      });
      return elements.slice(0, 50);
    });
    console.log(`  Control Center elements (${pageContent.length}):`);
    pageContent.slice(0, 25).forEach((e) => console.log(`    ${e}`));

    // Check if there's a company list or user list
    const tables = await hPage.evaluate(() => {
      const cols: string[] = [];
      document.querySelectorAll('th, .ant-table-column-title').forEach((th) => {
        const text = th.textContent?.trim();
        if (text) cols.push(text);
      });
      return cols;
    });
    if (tables.length > 0) console.log(`  Table columns: ${tables.join(', ')}`);

    // Look for impersonate buttons or links
    const impersonateElements = await hPage.evaluate(() => {
      const found: string[] = [];
      document.querySelectorAll('button, a, [role="button"]').forEach((el) => {
        const text = el.textContent?.trim().toLowerCase() || '';
        if (text.includes('impersonat') || text.includes('log in as') || text.includes('switch') || text.includes('act as')) {
          found.push(`${el.tagName}: "${el.textContent?.trim()}"`);
        }
      });
      return found;
    });
    if (impersonateElements.length > 0) {
      console.log(`  Impersonate buttons found: ${impersonateElements.join(', ')}`);
    } else {
      console.log('  No impersonate buttons found on control center root');
    }

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

    // ── TRIN 2: Naviger til Control Center ───────────────────────────────
    console.log('Trin 2: Naviger til Control Center');
    await hideLabel(page);
    await showStepBadge(page, 2, 'Control Center');

    await showLabelTimed(page, 'open-control', ttsMap);

    // Try sidebar link first
    const ccLink = page.locator('li span, a span, nav a').filter({
      hasText: /Control Center|Kontrolcenter|Admin/i,
    }).first();

    if (await ccLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(ccLink);
      await wait(page, 800);
      await ccLink.click();
      await unhighlight(page);
      await page.waitForLoadState('domcontentloaded');
      await wait(page, 3000);
    } else {
      // Navigate directly
      await page.goto(`${BASE_URL}/app/control-center`);
      await page.waitForLoadState('domcontentloaded');
      await wait(page, 3000);
    }
    await dismissToasts(page);

    await showLabelTimed(page, 'control-center', ttsMap);

    // ── TRIN 3: Find virksomhed/bruger ──────────────────────────────────
    console.log('Trin 3: Find virksomhed at impersonere');
    await showStepBadge(page, 3, 'Find virksomhed');

    // Analyse: look for company/user list, tabs, search
    const pageElements = await page.evaluate(() => {
      const info: { tabs: string[]; buttons: string[]; tables: boolean; search: boolean } = {
        tabs: [], buttons: [], tables: false, search: false,
      };
      document.querySelectorAll('[role="tab"], .ant-tabs-tab').forEach((t) => {
        const text = t.textContent?.trim();
        if (text) info.tabs.push(text);
      });
      document.querySelectorAll('button').forEach((b) => {
        const text = b.textContent?.trim();
        if (text && text.length < 50) info.buttons.push(text);
      });
      info.tables = !!document.querySelector('.ant-table, table');
      info.search = !!document.querySelector('input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]');
      return info;
    });
    console.log(`  Page: tabs=[${pageElements.tabs.join(', ')}] tables=${pageElements.tables} search=${pageElements.search}`);
    console.log(`  Buttons: ${pageElements.buttons.slice(0, 10).join(', ')}`);

    // If there's a search field, type in it for demo
    const searchInput = page.locator('input[type="search"], input[placeholder*="Search"], input[placeholder*="search"], input[placeholder*="Søg"]').first();
    if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(searchInput);
      await showLabelTimed(page, 'find-company', ttsMap);
      await searchInput.click();
      await searchInput.fill('Demo');
      await wait(page, 2000);
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'find-company', ttsMap);
    }

    // ── TRIN 4: Klik Impersonate ────────────────────────────────────────
    console.log('Trin 4: Impersonér');
    await showStepBadge(page, 4, 'Impersonér');

    // Look for impersonate button/link in the page
    const impersonateBtn = page.locator('button, a, [role="button"]').filter({
      hasText: /Impersonat|Log in as|Switch to|Act as|Repræsenter/i,
    }).first();

    if (await impersonateBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(impersonateBtn);
      await showLabelTimed(page, 'click-impersonate', ttsMap);
      await impersonateBtn.click();
      await unhighlight(page);

      await page.waitForLoadState('domcontentloaded');
      await wait(page, 4000);
      await dismissToasts(page);

      await showLabelTimed(page, 'impersonating', ttsMap);
      await showLabelTimed(page, 'see-as-user', ttsMap);

      // ── TRIN 5: Stop impersonering ────────────────────────────────────
      console.log('Trin 5: Stop impersonering');
      await showStepBadge(page, 5, 'Stop impersonering');

      // Look for stop banner/button
      const stopBtn = page.locator('button, a, [role="button"], div').filter({
        hasText: /Stop impersonat|Exit|Go back|Afslut|Stop/i,
      }).first();

      if (await stopBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await highlight(stopBtn);
        await showLabelTimed(page, 'stop-impersonate', ttsMap);
        await stopBtn.click();
        await unhighlight(page);

        await page.waitForLoadState('domcontentloaded');
        await wait(page, 3000);
        await dismissToasts(page);

        await showLabelTimed(page, 'back-to-staff', ttsMap);
      } else {
        await showLabelTimed(page, 'stop-impersonate', ttsMap);
        await showLabelTimed(page, 'back-to-staff', ttsMap);
      }
    } else {
      // Impersonate button not found — may be in a table row or dropdown
      // Try clicking first table row to open company detail
      const firstRow = page.locator('.ant-table-row, tr[data-row-key]').first();
      if (await firstRow.isVisible({ timeout: 3000 }).catch(() => false)) {
        await highlight(firstRow);
        await wait(page, 800);
        await firstRow.click();
        await unhighlight(page);
        await wait(page, 3000);

        // Look for impersonate on detail page
        const detailImpersonate = page.locator('button, a').filter({
          hasText: /Impersonat|Log in as|Switch|Act as/i,
        }).first();

        if (await detailImpersonate.isVisible({ timeout: 3000 }).catch(() => false)) {
          await highlight(detailImpersonate);
          await showLabelTimed(page, 'click-impersonate', ttsMap);
          await detailImpersonate.click();
          await unhighlight(page);
          await wait(page, 4000);

          await showLabelTimed(page, 'impersonating', ttsMap);
          await showLabelTimed(page, 'see-as-user', ttsMap);
          await showLabelTimed(page, 'stop-impersonate', ttsMap);
          await showLabelTimed(page, 'back-to-staff', ttsMap);
        } else {
          console.log('  [warn] Impersonate button not found on detail page');
          await showLabelTimed(page, 'click-impersonate', ttsMap);
          await showLabelTimed(page, 'impersonating', ttsMap);
          await showLabelTimed(page, 'see-as-user', ttsMap);
          await showLabelTimed(page, 'stop-impersonate', ttsMap);
          await showLabelTimed(page, 'back-to-staff', ttsMap);
        }
      } else {
        console.log('  [warn] No table rows or impersonate buttons found');
        await showLabelTimed(page, 'click-impersonate', ttsMap);
        await showLabelTimed(page, 'impersonating', ttsMap);
        await showLabelTimed(page, 'see-as-user', ttsMap);
        await showLabelTimed(page, 'stop-impersonate', ttsMap);
        await showLabelTimed(page, 'back-to-staff', ttsMap);
      }
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
