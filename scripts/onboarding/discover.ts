/**
 * WasteHero Onboarding — Discovery Agent (Deep Crawl)
 *
 * Logs into WasteHero DEVELOPMENT, expands every sidebar section,
 * clicks every sub-page, and for each page:
 *   1. Screenshots the page
 *   2. Captures an accessibility snapshot (structured element tree)
 *   3. Discovers action buttons (Create, Add, Export, Edit, Delete...)
 *   4. Clicks each action → inventories modals/forms/drawers
 *   5. Records form fields, dropdowns, selectors
 *   6. Maps GraphQL mutations to each action (from frontend source)
 *
 * Output: deep-flow-map.json — the enriched source of truth
 *
 * SAFETY: Hard-fails if BASE_URL points at production.
 *
 * Usage: npx tsx scripts/onboarding/discover.ts
 */

import { chromium, Page, BrowserContext, Locator } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────

const BASE_URL = process.env.WASTEHERO_DEV_URL || 'https://app-development.wastehero.io';
const EMAIL = process.env.WASTEHERO_DEV_EMAIL || 'Okjoeller@wastehero.io';
const PASSWORD = process.env.WASTEHERO_DEV_PASSWORD || 'Jrg77hht';

const OUTPUT_DIR = path.join(__dirname, '../../onboarding-output');
const SCREENSHOTS_DIR = path.join(OUTPUT_DIR, 'screenshots');
const SNAPSHOTS_DIR = path.join(OUTPUT_DIR, 'snapshots');
const DEEP_FLOW_MAP_PATH = path.join(OUTPUT_DIR, 'deep-flow-map.json');
const LEGACY_FLOW_MAP_PATH = path.join(OUTPUT_DIR, 'flow-map.json');

// Frontend source for GraphQL mutation mapping
const FRONTEND_SRC = process.env.WASTEHERO_FRONTEND_SRC
  || path.join(__dirname, '../../../wastehero_frontend/src');

// ─── Production guard ───────────────────────────────────────────────────────

function assertNotProduction(url: string) {
  const PRODUCTION_HOSTNAMES = ['app.wastehero.io', 'www.wastehero.io', 'wastehero.io'];
  const hostname = new URL(url).hostname;
  if (PRODUCTION_HOSTNAMES.includes(hostname)) {
    throw new Error(
      `SAFETY ABORT: BASE_URL points at production (${hostname}). ` +
        'Only development/staging allowed.'
    );
  }
  if (
    !hostname.includes('development') &&
    !hostname.includes('staging') &&
    !hostname.includes('localhost')
  ) {
    throw new Error(
      `SAFETY ABORT: "${url}" doesn't look like a safe non-production environment.`
    );
  }
  console.log(`[OK] Environment: ${hostname}\n`);
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface FormField {
  selector: string;
  type: string;         // input, select, textarea, checkbox, radio, dropdown
  label: string;
  placeholder: string;
  required: boolean;
  options?: string[];   // for select/dropdown fields
}

interface ActionDetail {
  label: string;
  selector: string;
  type: string;         // button, link, menuitem
  opens: 'modal' | 'drawer' | 'page' | 'dropdown' | 'none';
  modalTitle?: string;
  formFields: FormField[];
  mutation?: string;    // matched GraphQL mutation name
  mutationFile?: string;
}

interface DeepModule {
  id: string;
  name: string;
  parent: string;
  url: string;
  pageTitle: string;
  screenshot: string;
  a11ySnapshot: string; // path to accessibility snapshot file
  actions: ActionDetail[];
  mutations: string[];  // GraphQL mutations used on this page (from source mapping)
  discoveredAt: string;
}

interface DeepFlowMap {
  platform: string;
  environment: string;
  generatedAt: string;
  sidebarStructure: Record<string, string[]>;
  modules: DeepModule[];
  mutationIndex: Record<string, { file: string; route?: string }>;
}

// ─── GraphQL mutation mapping ──────────────────────────────────────────────

interface MutationMapping {
  name: string;
  file: string;
}

function buildMutationIndex(): MutationMapping[] {
  const mappings: MutationMapping[] = [];

  if (!fs.existsSync(FRONTEND_SRC)) {
    console.log('[warn] Frontend source not found — skipping mutation mapping');
    return mappings;
  }

  console.log('[mutation-index] Scanning frontend source for useMutation calls...');

  function scanDir(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__generated__' || entry.name === '.git') continue;
        scanDir(fullPath);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          // Match mutation constants: gql`mutation XXX` or const XXX = gql`
          const gqlMatches = content.matchAll(/(?:mutation|MUTATION|CREATE|UPDATE|DELETE|BULK)[A-Z_]+/g);
          for (const match of gqlMatches) {
            const name = match[0];
            // Avoid matching comments or type references — only gql tagged templates and useMutation calls
            if (content.includes(`useMutation`) || content.includes('gql`')) {
              if (!mappings.some((m) => m.name === name && m.file === path.relative(FRONTEND_SRC, fullPath))) {
                mappings.push({
                  name,
                  file: path.relative(FRONTEND_SRC, fullPath),
                });
              }
            }
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  scanDir(FRONTEND_SRC);
  console.log(`[mutation-index] Found ${mappings.length} mutation references\n`);
  return mappings;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function takeScreenshot(page: Page, name: string): Promise<string> {
  const filename = `${name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: false });
  return path.relative(OUTPUT_DIR, filepath);
}

async function takeA11ySnapshot(page: Page, name: string): Promise<string> {
  const filename = `${name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.txt`;
  const filepath = path.join(SNAPSHOTS_DIR, filename);
  const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));
  return path.relative(OUTPUT_DIR, filepath);
}

async function getPageTitle(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h1 = document.querySelector('h1');
    if (h1?.textContent?.trim()) return h1.textContent.trim();
    const h2 = document.querySelector('h2');
    if (h2?.textContent?.trim()) return h2.textContent.trim();
    return document.title || '';
  });
}

// ─── Action discovery ──────────────────────────────────────────────────────

const ACTION_PATTERNS = [
  // Primary actions (create/add)
  { pattern: /^(Create|Add|New|Opret|Tilføj)\b/i, type: 'create' },
  // Export actions
  { pattern: /^(Export|Download|Eksport)/i, type: 'export' },
  // Edit actions
  { pattern: /^(Edit|Update|Rediger)/i, type: 'edit' },
  // Delete actions
  { pattern: /^(Delete|Remove|Slet|Fjern)/i, type: 'delete' },
  // Other common actions
  { pattern: /^(Import|Upload|Importer)/i, type: 'import' },
  { pattern: /^(Filter|Search|Søg)/i, type: 'filter' },
  { pattern: /^(Action|Actions|Handling)/i, type: 'action-menu' },
];

async function discoverActions(page: Page): Promise<ActionDetail[]> {
  const actions: ActionDetail[] = [];

  // Find all visible buttons and links that match action patterns
  const candidates = await page.evaluate(() => {
    const results: { text: string; selector: string; tag: string; role: string }[] = [];

    // Buttons
    document.querySelectorAll('button').forEach((btn) => {
      const text = btn.textContent?.trim() || '';
      if (text && text.length < 50 && btn.offsetParent !== null) {
        const testId = btn.getAttribute('data-testid');
        const selector = testId
          ? `[data-testid="${testId}"]`
          : btn.className
            ? `button.${btn.className.split(' ').filter(c => c && !c.includes(' ')).slice(0, 2).join('.')}`
            : `button:has-text("${text.substring(0, 30)}")`;
        results.push({
          text,
          selector,
          tag: 'button',
          role: btn.getAttribute('role') || 'button',
        });
      }
    });

    // Links that look like actions (not navigation)
    document.querySelectorAll('a[href*="create"], a[href*="new"], a[href*="add"]').forEach((a) => {
      const text = a.textContent?.trim() || '';
      if (text && text.length < 50 && (a as HTMLElement).offsetParent !== null) {
        results.push({
          text,
          selector: `a:has-text("${text.substring(0, 30)}")`,
          tag: 'a',
          role: 'link',
        });
      }
    });

    return results;
  });

  // Filter to action-like buttons
  for (const candidate of candidates) {
    const isAction = ACTION_PATTERNS.some((p) => p.pattern.test(candidate.text));
    if (!isAction) continue;

    actions.push({
      label: candidate.text,
      selector: candidate.selector,
      type: candidate.tag,
      opens: 'none',
      formFields: [],
    });
  }

  return actions;
}

// ─── Form field discovery ──────────────────────────────────────────────────

async function discoverFormFields(page: Page): Promise<FormField[]> {
  return page.evaluate(() => {
    const fields: {
      selector: string;
      type: string;
      label: string;
      placeholder: string;
      required: boolean;
      options?: string[];
    }[] = [];

    // Regular inputs
    document.querySelectorAll('input:not([type="hidden"]):not([type="submit"])').forEach((input) => {
      const el = input as HTMLInputElement;
      if (el.offsetParent === null) return; // hidden

      const label = el.closest('label')?.textContent?.trim()
        || el.getAttribute('aria-label')
        || document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()
        || '';

      const testId = el.getAttribute('data-testid');
      const selector = testId
        ? `[data-testid="${testId}"]`
        : el.id
          ? `#${el.id}`
          : el.placeholder
            ? `input[placeholder="${el.placeholder}"]`
            : `input[name="${el.name}"]`;

      fields.push({
        selector,
        type: el.type || 'text',
        label: label.substring(0, 100),
        placeholder: el.placeholder || '',
        required: el.required || el.getAttribute('aria-required') === 'true',
      });
    });

    // Textareas
    document.querySelectorAll('textarea').forEach((ta) => {
      const el = ta as HTMLTextAreaElement;
      if (el.offsetParent === null) return;

      const label = el.closest('label')?.textContent?.trim()
        || el.getAttribute('aria-label')
        || '';

      fields.push({
        selector: el.id ? `#${el.id}` : `textarea[name="${el.name}"]`,
        type: 'textarea',
        label: label.substring(0, 100),
        placeholder: el.placeholder || '',
        required: el.required,
      });
    });

    // Ant Design selects (the app uses antd)
    document.querySelectorAll('.ant-select').forEach((sel) => {
      const el = sel as HTMLElement;
      if (el.offsetParent === null) return;

      // Find label from the form item wrapper
      const formItem = el.closest('.ant-form-item');
      const label = formItem?.querySelector('.ant-form-item-label')?.textContent?.trim() || '';

      const testId = el.getAttribute('data-testid');
      const selector = testId
        ? `[data-testid="${testId}"]`
        : `.ant-select`;

      fields.push({
        selector,
        type: 'dropdown',
        label: label.substring(0, 100),
        placeholder: el.querySelector('.ant-select-selection-placeholder')?.textContent || '',
        required: formItem?.querySelector('.ant-form-item-required') !== null,
      });
    });

    // Checkboxes
    document.querySelectorAll('.ant-checkbox-wrapper, input[type="checkbox"]').forEach((cb) => {
      const el = cb as HTMLElement;
      if (el.offsetParent === null) return;

      const label = el.textContent?.trim() || '';
      fields.push({
        selector: `text="${label.substring(0, 30)}"`,
        type: 'checkbox',
        label: label.substring(0, 100),
        placeholder: '',
        required: false,
      });
    });

    return fields;
  });
}

// ─── Deep inspect: click an action and discover what it opens ──────────────

async function deepInspectAction(
  page: Page,
  action: ActionDetail
): Promise<ActionDetail> {
  const urlBefore = page.url();
  const result = { ...action };

  try {
    // Wait for any ongoing animations/loads
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Click the action button
    const locator = page.locator(action.selector).first();
    if (!(await locator.isVisible({ timeout: 3000 }).catch(() => false))) {
      result.opens = 'none';
      return result;
    }

    await locator.click({ timeout: 5000 });
    await page.waitForTimeout(1500);

    // Check what opened
    const modalVisible = await page.locator('.ant-modal:visible, [role="dialog"]:visible').first()
      .isVisible({ timeout: 2000 }).catch(() => false);

    const drawerVisible = await page.locator('.ant-drawer:visible').first()
      .isVisible({ timeout: 1000 }).catch(() => false);

    const urlChanged = page.url() !== urlBefore;

    if (modalVisible) {
      result.opens = 'modal';
      result.modalTitle = await page.locator('.ant-modal:visible .ant-modal-title, [role="dialog"]:visible h2, [role="dialog"]:visible h3')
        .first().textContent({ timeout: 2000 }).catch(() => '') || '';
      result.formFields = await discoverFormFields(page);

      // Close modal
      await page.locator('.ant-modal:visible .ant-modal-close, [role="dialog"]:visible button[aria-label="Close"]')
        .first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    } else if (drawerVisible) {
      result.opens = 'drawer';
      result.modalTitle = await page.locator('.ant-drawer:visible .ant-drawer-title')
        .first().textContent({ timeout: 2000 }).catch(() => '') || '';
      result.formFields = await discoverFormFields(page);

      // Close drawer
      await page.locator('.ant-drawer:visible .ant-drawer-close')
        .first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    } else if (urlChanged) {
      result.opens = 'page';
      result.formFields = await discoverFormFields(page);

      // Navigate back
      await page.goBack({ timeout: 10000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    } else {
      // Might be a dropdown menu
      const dropdownVisible = await page.locator('.ant-dropdown:visible, .ant-popover:visible, [role="menu"]:visible')
        .first().isVisible({ timeout: 1000 }).catch(() => false);

      if (dropdownVisible) {
        result.opens = 'dropdown';
        // Collect menu items
        const menuItems = await page.locator('.ant-dropdown:visible li, .ant-popover:visible li, [role="menu"]:visible [role="menuitem"]')
          .allTextContents().catch(() => []);
        result.formFields = menuItems.map((text) => ({
          selector: `text="${text.trim()}"`,
          type: 'menuitem',
          label: text.trim(),
          placeholder: '',
          required: false,
        }));

        // Close by pressing Escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }
  } catch (err) {
    console.warn(`     [deep-inspect] Error on "${action.label}": ${err}`);
  }

  return result;
}

// ─── Sidebar structure ─────────────────────────────────────────────────────

const PARENT_SECTIONS = [
  'Data & Analytics',
  'Customers',
  'Tickets',
  'Operations',
  'Fleet',
  'Assets',
];

const DIRECT_SECTIONS = ['Alerts'];

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  assertNotProduction(BASE_URL);
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

  // Phase 0: Build mutation index from frontend source
  const mutationMappings = buildMutationIndex();
  const mutationIndex: Record<string, { file: string; route?: string }> = {};
  for (const m of mutationMappings) {
    mutationIndex[m.name] = { file: m.file };
  }

  // Helper: find mutations relevant to a URL path
  function findMutationsForRoute(urlPath: string): string[] {
    const routeSegments = urlPath.split('/').filter(Boolean);
    return mutationMappings
      .filter((m) => {
        const fileLower = m.file.toLowerCase();
        return routeSegments.some((seg) =>
          seg.length > 3 && fileLower.includes(seg.replace(/-/g, ''))
        );
      })
      .map((m) => m.name)
      .filter((name, i, arr) => arr.indexOf(name) === i)
      .slice(0, 20);
  }

  console.log('WasteHero Deep Discovery Agent starting...');
  console.log(`Output: ${OUTPUT_DIR}\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const flowMap: DeepFlowMap = {
    platform: 'WasteHero',
    environment: BASE_URL,
    generatedAt: new Date().toISOString(),
    sidebarStructure: {},
    modules: [],
    mutationIndex,
  };

  const seenUrls = new Set<string>();

  async function captureModule(name: string, parent: string): Promise<DeepModule | null> {
    const urlPath = new URL(page.url()).pathname;
    if (seenUrls.has(urlPath) || page.url().includes('/login')) return null;

    const bodyText = await page.textContent('body');
    if (bodyText?.includes('Route not found')) {
      console.log(`     404 — skipping`);
      return null;
    }

    seenUrls.add(urlPath);

    const title = await getPageTitle(page);
    console.log(`     Captured: ${title || name} (${urlPath})`);

    // 1. Screenshot
    const ssPath = await takeScreenshot(page, `${parent}-${name}`);

    // 2. Accessibility snapshot
    const a11yPath = await takeA11ySnapshot(page, `${parent}-${name}`);

    // 3. Discover actions (Create, Add, Export, etc.)
    console.log(`     Discovering actions...`);
    const rawActions = await discoverActions(page);
    console.log(`     Found ${rawActions.length} action(s): ${rawActions.map((a) => a.label).join(', ') || '(none)'}`);

    // 4. Deep inspect each action (click → check what opens → inventory fields)
    const actions: ActionDetail[] = [];
    for (const action of rawActions.slice(0, 8)) { // limit to 8 actions per page
      console.log(`       Inspecting: "${action.label}"...`);
      const detailed = await deepInspectAction(page, action);

      // 5. Match to GraphQL mutation
      const labelNorm = action.label.toLowerCase().replace(/\s+/g, '_');
      const matchedMutation = mutationMappings.find((m) => {
        const mutNorm = m.name.toLowerCase();
        return mutNorm.includes(labelNorm) || labelNorm.includes(mutNorm.replace(/^(mutation_|bulk_)/, ''));
      });
      if (matchedMutation) {
        detailed.mutation = matchedMutation.name;
        detailed.mutationFile = matchedMutation.file;
      }

      actions.push(detailed);

      // Re-navigate if the action changed the URL
      if (page.url() !== `${BASE_URL}${urlPath}`) {
        await page.goto(`${BASE_URL}${urlPath}`);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    // 6. Find route-level mutations from source
    const routeMutations = findMutationsForRoute(urlPath);

    return {
      id: `${parent}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name,
      parent,
      url: urlPath,
      pageTitle: title,
      screenshot: ssPath,
      a11ySnapshot: a11yPath,
      actions,
      mutations: routeMutations,
      discoveredAt: new Date().toISOString(),
    };
  }

  try {
    // ── Login ──────────────────────────────────────────────────────────────
    console.log('Logging in...');
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    await page.fill('input[placeholder="Username"]', EMAIL);
    await page.fill('input[placeholder="Password"]', PASSWORD);
    await page.click('button:has-text("Log in")');

    await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 20000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);
    console.log('Login successful\n');

    // ── Dashboard ──────────────────────────────────────────────────────────
    const dashMod = await captureModule('Dashboard', 'Home');
    if (dashMod) flowMap.modules.push(dashMod);

    // ── Explore each expandable sidebar section ────────────────────────────
    for (const sectionName of PARENT_SECTIONS) {
      console.log(`\nSidebar: ${sectionName}`);

      await page.goto(`${BASE_URL}/app/dashboard`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(800);

      const parentItem = page
        .locator(`li[role="none"] span, li span`)
        .filter({ hasText: new RegExp(`^${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
        .first();

      if (!(await parentItem.isVisible().catch(() => false))) {
        console.log(`  Not visible — skipping`);
        continue;
      }

      await parentItem.click();
      await page.waitForTimeout(1200);

      const subItemTexts = await page.evaluate(() => {
        const items: string[] = [];
        document.querySelectorAll('li[role="menuitem"] span').forEach((el) => {
          const text = el.textContent?.trim();
          if (text && !items.includes(text)) items.push(text);
        });
        return items;
      });

      const filtered = subItemTexts.filter(
        (t) => !PARENT_SECTIONS.includes(t) && !DIRECT_SECTIONS.includes(t)
      );

      flowMap.sidebarStructure[sectionName] = filtered;
      console.log(`  Sub-items: ${filtered.join(', ') || '(none)'}`);

      for (const subName of filtered) {
        try {
          await page.goto(`${BASE_URL}/app/dashboard`);
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(600);

          await parentItem.click();
          await page.waitForTimeout(800);

          const subItem = page
            .locator('li[role="menuitem"] span')
            .filter({ hasText: new RegExp(`^${subName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
            .first();

          if (!(await subItem.isVisible().catch(() => false))) {
            console.log(`  -> ${subName}: not visible after expand`);
            continue;
          }

          console.log(`  -> ${subName}`);
          const urlBefore = page.url();
          await subItem.click();
          await page.waitForTimeout(2000);
          await page.waitForLoadState('networkidle');

          if (page.url() === urlBefore) {
            console.log(`     No navigation — skipping`);
            continue;
          }

          const mod = await captureModule(subName, sectionName);
          if (mod) flowMap.modules.push(mod);
        } catch (err) {
          console.warn(`     Error on ${subName}: ${err}`);
        }
      }
    }

    // ── Direct sections (Alerts) ───────────────────────────────────────────
    for (const sectionName of DIRECT_SECTIONS) {
      console.log(`\nDirect: ${sectionName}`);
      await page.goto(`${BASE_URL}/app/dashboard`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(600);

      const item = page
        .locator('li[role="menuitem"] span')
        .filter({ hasText: new RegExp(`^${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
        .first();

      if (await item.isVisible().catch(() => false)) {
        await item.click();
        await page.waitForTimeout(2000);
        await page.waitForLoadState('networkidle');
        const mod = await captureModule(sectionName, sectionName);
        if (mod) flowMap.modules.push(mod);
      }
    }

    // ── Save deep flow map ─────────────────────────────────────────────────
    fs.writeFileSync(DEEP_FLOW_MAP_PATH, JSON.stringify(flowMap, null, 2));

    // Also write legacy flow-map.json for backward compat
    const legacyMap = {
      platform: flowMap.platform,
      environment: flowMap.environment,
      generated_at: flowMap.generatedAt,
      sidebar_structure: flowMap.sidebarStructure,
      modules: flowMap.modules.map((m) => ({
        id: m.id,
        name: m.name,
        parent: m.parent,
        url: m.url,
        page_title: m.pageTitle,
        description: '',
        screenshot: m.screenshot,
        key_features: m.actions.map((a) => a.label),
        onboarding_steps: [],
      })),
    };
    fs.writeFileSync(LEGACY_FLOW_MAP_PATH, JSON.stringify(legacyMap, null, 2));

    // ── Summary ────────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(60));
    console.log('Deep Discovery complete!');
    console.log(`Deep flow map: ${DEEP_FLOW_MAP_PATH}`);
    console.log(`Screenshots:   ${SCREENSHOTS_DIR}`);
    console.log(`A11y snapshots: ${SNAPSHOTS_DIR}`);
    console.log(`\nSidebar structure:`);
    for (const [section, items] of Object.entries(flowMap.sidebarStructure)) {
      console.log(`  ${section}: ${items.join(', ') || '(direct)'}`);
    }
    console.log(`\nModules captured: ${flowMap.modules.length}`);
    let totalActions = 0;
    for (const m of flowMap.modules) {
      const actionSummary = m.actions.length > 0
        ? ` — ${m.actions.length} action(s): ${m.actions.map((a) => `${a.label}[${a.opens}]`).join(', ')}`
        : '';
      console.log(`  - [${m.parent}] ${m.name} (${m.url})${actionSummary}`);
      totalActions += m.actions.length;
    }
    console.log(`\nTotal actions discovered: ${totalActions}`);
    console.log(`Mutation index entries: ${Object.keys(flowMap.mutationIndex).length}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Deep Discovery agent failed:', err.message);
  process.exit(1);
});
