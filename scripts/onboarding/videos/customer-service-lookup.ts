/**
 * How-To Video: Kundeservice — Slå kunde op
 * (Customer Service — Look up a customer)
 *
 * Strategy: TTS-first recording
 *   Phase 1 — Pre-generate all TTS audio and get exact durations
 *   Phase 1.5 — Set language to Danish (headless)
 *   Phase 2 — Record video, pacing each step to match its TTS duration
 *   Phase 3 — Merge TTS audio into the video at the recorded timestamps
 *
 * Flow:
 *   Login → Customers > Properties → Search → Property Detail
 *   → Overview (owner, property info)
 *   → Containers tab (waste fractions)
 *   → Agreements tab (contracts)
 *   → Collections tab (route & pickup history)
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

const VIDEO_BASE = path.join(__dirname, '../../../onboarding-output/videos');
const VIDEO_DIR = path.join(VIDEO_BASE, 'customer-service-lookup');
const AUDIO_DIR = path.join(VIDEO_DIR, 'tts-segments');

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

// ─── Narration segments ─────────────────────────────────────────────────────

const NARRATIONS: { id: string; text: string }[] = [
  { id: 'intro',      text: 'I denne video viser vi, hvordan du som kundeservicemedarbejder slår en kunde op og finder relevant information' },
  { id: 'login',      text: 'Indtast dit brugernavn og adgangskode, og klik på Log ind' },
  { id: 'dashboard',  text: 'Du er nu på Dashboardet — herfra navigerer vi til kundeområdet' },
  { id: 'nav-cust',   text: 'Åbn sektionen Customers i venstre sidepanel' },
  { id: 'nav-prop',   text: 'Klik på Properties for at se en liste over alle ejendomme' },
  { id: 'search',     text: 'Brug søgefeltet til at finde en kunde — du kan søge på adresse, ejendomsnummer eller ejer' },
  { id: 'click-row',  text: 'Klik på ejendommen for at åbne kundens detaljeside' },
  { id: 'overview',   text: 'Oversigten viser ejendomsoplysninger til venstre — adresse, ejendomsnummer, type og område' },
  { id: 'owner',      text: 'Under kontaktpersoner kan du se ejeren og andre tilknyttede kontakter med deres roller' },
  { id: 'tab-cont',   text: 'Klik på fanen Containers for at se kundens beholdere og affaldsfraktioner' },
  { id: 'waste-fr',   text: 'Her ser du alle containere med affaldsfraktion, containertype, afhentningsindstilling og status' },
  { id: 'tab-agree',  text: 'Klik nu på fanen Agreements for at se kundens aftaler og kontrakter' },
  { id: 'contracts',  text: 'Aftaleoversigten viser aktive aftaler med affaldsfraktion, pris, afhentningsplan og periode' },
  { id: 'tab-coll',   text: 'Gå til fanen Collections for at se information om ruter og afhentningshistorik' },
  { id: 'route-info', text: 'Her kan du se tidligere afhentninger, hvornår de fandt sted, og hvilken rute der betjener ejendommen' },
  { id: 'summary',    text: 'Det var det! Du kan nu slå en kunde op og finde information om affaldsfraktioner, afhentninger, kontrakter og ejerskab' },
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

  const destWebm = path.join(VIDEO_DIR, 'customer-service-lookup.webm');
  const destMp4 = path.join(VIDEO_DIR, 'customer-service-lookup.mp4');
  if (fs.existsSync(destWebm)) fs.unlinkSync(destWebm);
  if (fs.existsSync(destMp4)) fs.unlinkSync(destMp4);

  console.log('Optager: Kundeservice — Slå kunde op');
  console.log(`Opløsning: ${VIEWPORT.width}x${VIEWPORT.height}`);
  console.log('TTS: ElevenLabs (dansk)\n');

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 1 — Pre-generér TTS
  // ══════════════════════════════════════════════════════════════════════════
  const ttsMap = await preGenerateAllTTS();

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 1.5 — Pre-flight: set language to Danish (headless)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── Fase 1.5: Sætter sprog til dansk ──');
  {
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
    console.log('  [lang] Navigerer til profil...');
    await hPage.goto(`${BASE_URL}/app/profile/information`);
    await hPage.waitForTimeout(4000);

    const editBtn = hPage.locator('button').filter({ hasText: /Edit|Rediger/i }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('  [lang] Klikker "Edit" for at aktivere redigering...');
      await editBtn.click();
      await hPage.waitForTimeout(2000);
    }

    const prefLink = hPage.locator('a, div, span').filter({ hasText: /^Preference$/i }).first();
    if (await prefLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await prefLink.click();
      await hPage.waitForTimeout(1000);
    }

    const langItem = hPage.locator('.ant-form-item').filter({ hasText: /Language|Sprog/i }).first();
    if (await langItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      const currentLang = await langItem.locator('.ant-select-selection-item').textContent().catch(() => '') ||
                          await langItem.evaluate((el) => el.textContent?.match(/English|Danish|Dansk|Norwegian|Finnish|Swedish/i)?.[0] || '');
      console.log(`  [lang] Nuværende sprog: "${currentLang}"`);

      if (currentLang?.match(/Danish|Dansk/i)) {
        console.log('  [lang] Allerede dansk — springer over.');
      } else {
        const langSelect = langItem.locator('.ant-select').first();
        if (await langSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
          await langSelect.click();
          await hPage.waitForTimeout(1500);

          let found = false;
          const dropdown = hPage.locator('.ant-select-dropdown:visible').last();
          const danishOpt = dropdown.locator('.ant-select-item-option', { hasText: /Danish|Dansk/ }).first();

          if (await danishOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
            await danishOpt.click();
            found = true;
            console.log('  [lang] Valgte dansk.');
          }

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
            // Scroll down to make sure the save button is visible
            await hPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await hPage.waitForTimeout(1000);

            // Try multiple save button selectors
            const saveSelectors = [
              hPage.locator('button[type="submit"]').first(),
              hPage.locator('button').filter({ hasText: /^Save$|^Update$|^Gem$|^Opdater$|^Submit$/i }).first(),
              hPage.locator('button.ant-btn-primary').filter({ hasText: /Save|Update|Gem|Opdater|Submit/i }).first(),
              hPage.locator('button.ant-btn-primary').last(),
            ];

            let saved = false;
            for (const saveBtn of saveSelectors) {
              if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                const btnText = await saveBtn.textContent().catch(() => '');
                console.log(`  [lang] Klikker gem-knap: "${btnText?.trim()}"`);
                await saveBtn.click();
                await hPage.waitForTimeout(4000);
                console.log('  [lang] Gemt — sproget er nu dansk.');
                saved = true;
                break;
              }
            }

            if (!saved) {
              // Last resort: press Enter to submit the form
              console.log('  [lang] Gem-knap ikke fundet — prøver Enter...');
              await hPage.keyboard.press('Enter');
              await hPage.waitForTimeout(4000);
            }
          }
        }
      }
    }

    // ── Pre-flight: verify properties page loads and has data ──
    console.log('  [preflight] Tjekker Properties-siden...');
    await hPage.goto(`${BASE_URL}/app/customer-management/properties`);
    await hPage.waitForTimeout(5000);

    const rowCount = await hPage.locator('.ant-table-row').count();
    console.log(`  [preflight] Rækker i tabellen: ${rowCount}`);

    // Grab the first property's address for the search demo
    let firstAddress = '';
    const firstAddressCell = hPage.locator('.ant-table-row').first().locator('td').nth(1);
    if (await firstAddressCell.isVisible({ timeout: 2000 }).catch(() => false)) {
      firstAddress = (await firstAddressCell.textContent() || '').trim();
      console.log(`  [preflight] Første adresse: "${firstAddress}"`);
    }

    // Get the first property link for direct navigation fallback
    let firstPropertyHref = '';
    const firstLink = hPage.locator('.ant-table-row').first().locator('a').first();
    if (await firstLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      firstPropertyHref = (await firstLink.getAttribute('href')) || '';
      console.log(`  [preflight] Første ejendom link: "${firstPropertyHref}"`);
    }

    await hPage.close();
    await hCtx.close();
    await hBrowser.close();

    // Store preflight data for use in the recording phase
    (globalThis as any).__preflight = { firstAddress, firstPropertyHref };
  }
  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 2 — Optag video (paced by TTS durations)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── Fase 2: Optager video ──\n');

  const preflight = (globalThis as any).__preflight || { firstAddress: '', firstPropertyHref: '' };

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
    await showLabelTimed(page, 'intro', ttsMap);

    const emailInput = page.locator('input[placeholder="Username"]');
    await highlight(emailInput);
    await showLabelTimed(page, 'login', ttsMap);
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

    // ── TRIN 2: Naviger til Customers > Properties ──────────────────────
    console.log('Trin 2: Naviger til Customers > Properties');
    await hideLabel(page);
    await showStepBadge(page, 2, 'Kunder');
    await wait(page, 500);

    await showLabelTimed(page, 'nav-cust', ttsMap);

    const customersSection = await findSidebarItem('Customers', 'Kunder');
    if (customersSection) {
      await highlight(customersSection);
      await wait(page, 1000);
      await customersSection.click();
      await wait(page, 1000);
      await unhighlight(page);
    }

    await showLabelTimed(page, 'nav-prop', ttsMap);

    const propertiesLink = await findMenuItem('Properties', 'Ejendomme');
    if (propertiesLink) {
      await highlight(propertiesLink);
      await wait(page, 800);
      await propertiesLink.click();
      await page.waitForLoadState('domcontentloaded');
      await wait(page, 3000);
      await unhighlight(page);
    } else {
      await page.goto(`${BASE_URL}/app/customer-management/properties`);
      await page.waitForLoadState('domcontentloaded');
      await wait(page, 3000);
    }

    await dismissToasts(page);

    // ── TRIN 3: Søg efter en kunde ──────────────────────────────────────
    console.log('Trin 3: Søg efter kunde');
    await showStepBadge(page, 3, 'Søg kunde');

    // Find the search input area — properties page has search inputs for Address, Property Number, Owner
    const searchInput = page.locator('input[placeholder*="earch"], input[placeholder*="øg"], input[placeholder*="ddress"], input[placeholder*="dresse"]').first();

    if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(searchInput, 20);
      await showLabelTimed(page, 'search', ttsMap);

      // Type a search term (use the first few characters of the preflight address)
      const searchTerm = preflight.firstAddress
        ? preflight.firstAddress.split(/[,\s]+/).slice(0, 2).join(' ').substring(0, 20)
        : 'vej';
      await searchInput.click();
      await wait(page, 300);
      await searchInput.fill(searchTerm);
      await wait(page, 2500); // wait for debounced search
      await unhighlight(page);
    } else {
      // Fallback: just show the table
      await showLabelTimed(page, 'search', ttsMap);
    }

    await wait(page, 1500);
    await dismissToasts(page);

    // ── TRIN 4: Klik på en ejendom ──────────────────────────────────────
    console.log('Trin 4: Åbn ejendomsdetaljer');
    await showStepBadge(page, 4, 'Åbn ejendom');

    // Click the first row's link to open property detail
    const firstRow = page.locator('.ant-table-row').first();
    const propertyLink = firstRow.locator('a').first();

    if (await propertyLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(firstRow, 5);
      await showLabelTimed(page, 'click-row', ttsMap);
      await propertyLink.click();
      await unhighlight(page);
    } else if (preflight.firstPropertyHref) {
      await showLabelTimed(page, 'click-row', ttsMap);
      await page.goto(`${BASE_URL}${preflight.firstPropertyHref}`);
    } else {
      await showLabelTimed(page, 'click-row', ttsMap);
      await page.goto(`${BASE_URL}/app/customer-management/properties`);
      await wait(page, 3000);
      const fallbackRow = page.locator('.ant-table-row a').first();
      if (await fallbackRow.isVisible({ timeout: 3000 }).catch(() => false)) {
        await fallbackRow.click();
      }
    }

    await page.waitForLoadState('domcontentloaded');
    await wait(page, 4000);
    await dismissToasts(page);

    // ── TRIN 5: Oversigt — ejendomsoplysninger ──────────────────────────
    console.log('Trin 5: Oversigt — ejendomsoplysninger');
    await showStepBadge(page, 5, 'Oversigt');

    // Highlight the left sidebar property info card
    const propertyInfoCard = page.locator('.ant-card, [class*="Card"]').filter({
      hasText: /Property number|Ejendomsnummer|Address|Adresse/i,
    }).first();

    if (await propertyInfoCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(propertyInfoCard, 15);
      await showLabelTimed(page, 'overview', ttsMap);
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'overview', ttsMap);
    }

    // ── TRIN 6: Kontakter / Ejer ────────────────────────────────────────
    console.log('Trin 6: Kontakter / Ejer');
    await showStepBadge(page, 6, 'Ejer');

    // Look for the contacts/master data section in the left sidebar
    const contactsSection = page.locator('.ant-card, [class*="Card"], [class*="collapse"], .ant-collapse-item').filter({
      hasText: /Contact|Kontakt|Owner|Ejer|Master/i,
    }).first();

    if (await contactsSection.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Scroll the contacts section into view
      await contactsSection.scrollIntoViewIfNeeded();
      await wait(page, 500);
      await highlight(contactsSection, 15);
      await showLabelTimed(page, 'owner', ttsMap);
      await unhighlight(page);
    } else {
      // Try scrolling the left panel down to find contacts
      await page.evaluate(() => {
        const sidebar = document.querySelector('[class*="sidebar"], [class*="Sidebar"], [class*="left"]');
        if (sidebar) sidebar.scrollTop = sidebar.scrollHeight;
      });
      await wait(page, 1000);
      await showLabelTimed(page, 'owner', ttsMap);
    }

    // ── TRIN 7: Containers tab — affaldsfraktioner ──────────────────────
    console.log('Trin 7: Containers tab');
    await showStepBadge(page, 7, 'Containere');
    await hideLabel(page);

    // Click the Containers tab
    const containersTab = page.locator('.ant-tabs-tab, [role="tab"]').filter({
      hasText: /Containers|Containere|Beholdere/i,
    }).first();

    if (await containersTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(containersTab);
      await showLabelTimed(page, 'tab-cont', ttsMap);
      await containersTab.click();
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'tab-cont', ttsMap);
      // Try navigating to the containers tab via URL
      const currentUrl = page.url();
      const detailBase = currentUrl.replace(/\/(overview|containers|agreements|collection-log|tickets|invoices|contacts|history|subscriptions|export-runs)\/?$/, '');
      await page.goto(`${detailBase}/containers`);
    }

    await page.waitForLoadState('domcontentloaded');
    await wait(page, 3000);
    await dismissToasts(page);

    // Highlight the waste fraction column in the containers table
    const wasteFractionCell = page.locator('.ant-table-row .ant-tag, .ant-table-row [class*="Tag"]').first();
    if (await wasteFractionCell.isVisible({ timeout: 3000 }).catch(() => false)) {
      const wasteColumn = page.locator('.ant-table-row').first();
      await highlight(wasteColumn, 5);
      await showLabelTimed(page, 'waste-fr', ttsMap);
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'waste-fr', ttsMap);
    }

    // ── TRIN 8: Agreements tab — kontrakter ─────────────────────────────
    console.log('Trin 8: Agreements tab');
    await showStepBadge(page, 8, 'Aftaler');
    await hideLabel(page);

    const agreementsTab = page.locator('.ant-tabs-tab, [role="tab"]').filter({
      hasText: /Agreements|Aftaler/i,
    }).first();

    if (await agreementsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(agreementsTab);
      await showLabelTimed(page, 'tab-agree', ttsMap);
      await agreementsTab.click();
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'tab-agree', ttsMap);
      const currentUrl = page.url();
      const detailBase = currentUrl.replace(/\/(overview|containers|agreements|collection-log|tickets|invoices|contacts|history|subscriptions|export-runs)\/?$/, '');
      await page.goto(`${detailBase}/agreements`);
    }

    await page.waitForLoadState('domcontentloaded');
    await wait(page, 3000);
    await dismissToasts(page);

    // Highlight the agreements table
    const agreementsTable = page.locator('.ant-table').first();
    if (await agreementsTable.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(agreementsTable, 10);
      await showLabelTimed(page, 'contracts', ttsMap);
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'contracts', ttsMap);
    }

    // ── TRIN 9: Collections tab — rute og afhentning ────────────────────
    console.log('Trin 9: Collections tab');
    await showStepBadge(page, 9, 'Afhentninger');
    await hideLabel(page);

    const collectionsTab = page.locator('.ant-tabs-tab, [role="tab"]').filter({
      hasText: /Collections|Afhentninger|Indsamlinger/i,
    }).first();

    if (await collectionsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(collectionsTab);
      await showLabelTimed(page, 'tab-coll', ttsMap);
      await collectionsTab.click();
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'tab-coll', ttsMap);
      const currentUrl = page.url();
      const detailBase = currentUrl.replace(/\/(overview|containers|agreements|collection-log|tickets|invoices|contacts|history|subscriptions|export-runs)\/?$/, '');
      await page.goto(`${detailBase}/collection-log`);
    }

    await page.waitForLoadState('domcontentloaded');
    await wait(page, 3000);
    await dismissToasts(page);

    // Highlight the collections table showing route/pickup data
    const collectionsTable = page.locator('.ant-table').first();
    if (await collectionsTable.isVisible({ timeout: 3000 }).catch(() => false)) {
      await highlight(collectionsTable, 10);
      await showLabelTimed(page, 'route-info', ttsMap);
      await unhighlight(page);
    } else {
      await showLabelTimed(page, 'route-info', ttsMap);
    }

    // ── AFSLUTNING ──────────────────────────────────────────────────────
    console.log('Afslutning');
    await hideStepBadge(page);
    await hideLabel(page);
    await wait(page, 500);

    await showLabelTimed(page, 'summary', ttsMap);
    await hideLabel(page);
    await wait(page, 1500);

  } catch (err) {
    console.error('Fejl under optagelse:', err);
  }

  // ── Stop recording ──────────────────────────────────────────────────────
  await page.close();
  await context.close();
  await browser.close();

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 3 — Flet lyd og video (ffmpeg)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Fase 3: Fletter lyd og video ──');

  // Find the raw .webm recorded by Playwright
  const videoFiles = fs.readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm') && !f.includes('customer-service'));
  const latestRaw = videoFiles
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(VIDEO_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];

  if (!latestRaw) {
    console.error('Ingen rå video fundet i', VIDEO_DIR);
    process.exit(1);
  }

  const rawVideoPath = path.join(VIDEO_DIR, latestRaw.name);
  console.log(`Rå video: ${latestRaw.name}`);

  mergeAudioWithVideo(rawVideoPath, destMp4, ttsMap);

  // Rename raw webm for reference
  if (fs.existsSync(rawVideoPath) && rawVideoPath !== destWebm) {
    fs.renameSync(rawVideoPath, destWebm);
    console.log(`Rå video gemt som: ${destWebm}`);
  }

  console.log('\n── Færdig! ──');
  console.log(`  Video (med lyd): ${destMp4}`);
  console.log(`  Video (rå):      ${destWebm}`);
  console.log(`  TTS-segmenter:   ${AUDIO_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
