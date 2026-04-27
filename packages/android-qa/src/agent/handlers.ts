import type { Driver } from '../device/driver';
import type { LogcatTail } from '../recorder/logcat';
import type {
  Action,
  AppMap,
  Fingerprint,
  Screen,
  SessionState,
  ViewElement,
  ViewNode,
} from '../types/index';
import { fingerprintFromTree } from './fingerprint';
import { buildFrontier, type FrontierEntry } from './frontier';

/**
 * The qa-server's per-turn workhorses, extracted from the deleted Claude-driven
 * orchestrator loop. Each function does ONE thing — perceive a screen, dispatch
 * an action, record an outcome, refresh a frontier — so the HTTP handlers can
 * compose them without inheriting the loop's signal-handling and budget logic.
 *
 * No Claude API calls anywhere in this module. The decision-making lives in the
 * Claude Code skill that drives the server; everything here is deterministic.
 */

export interface PerceiveResult {
  tree: ViewNode;
  activity: string;
  shot: Buffer;
  logcatDelta: string[];
  fp: Fingerprint;
}

/**
 * Capture a turn's pre-action observations: view tree, current activity,
 * screenshot, logcat delta since `sinceTs`, and the screen fingerprint. No
 * retry logic, no state mutation — callers handle recovery and persistence.
 */
export async function perceive(
  driver: Driver,
  logcatTail: LogcatTail | null | undefined,
  sinceTs: number,
): Promise<PerceiveResult> {
  const tree = await driver.getViewTree();
  const activity = await driver.getCurrentActivity();
  const shot = await driver.screenshot();
  const logcatDelta = logcatTail ? logcatTail.getDelta(sinceTs) : [];
  const fp = fingerprintFromTree(tree, activity);
  return { tree, activity, shot, logcatDelta, fp };
}

/**
 * Light-weight post-action re-perceive: tree, activity, screenshot, fingerprint.
 * Does NOT touch logcat to avoid double-consuming the delta window that belongs
 * to the next turn's pre-perceive.
 */
export async function observeOutcome(
  driver: Driver,
): Promise<{ fp: Fingerprint; shot: Buffer }> {
  const tree = await driver.getViewTree();
  const activity = await driver.getCurrentActivity();
  const shot = await driver.screenshot();
  const fp = fingerprintFromTree(tree, activity);
  return { fp, shot };
}

/**
 * Convert a view tree into a Screen, carrying forward `tapped` / `outcomes` /
 * `marked` from the persisted app-map when this fingerprint has been seen
 * before. Without the carry-forward, every first-visit-this-session on a
 * known screen wipes run history to `tapped=false` and the frontier
 * re-promotes everything to priority 100.
 */
export function buildScreen(
  tree: ViewNode,
  activity: string,
  nowIso: string,
  fp: Fingerprint,
  appMap: AppMap,
): Screen {
  const elements: Record<string, ViewElement> = {};
  walkForElements(tree, elements, nowIso);
  const persisted = appMap.screens[fp];
  if (persisted) {
    for (const id of Object.keys(elements)) {
      const prior = persisted.elements[id];
      if (!prior) continue;
      elements[id] = {
        ...elements[id],
        firstSeen: prior.firstSeen,
        tapped: prior.tapped,
        outcomes: prior.outcomes.map((o) => ({ ...o })),
        ...(prior.marked !== undefined ? { marked: prior.marked } : {}),
      };
    }
  }
  return { fingerprint: fp, activity, elements };
}

function walkForElements(
  node: ViewNode,
  out: Record<string, ViewElement>,
  nowIso: string,
): void {
  if (node.resourceId && node.resourceId.length > 0 && !(node.resourceId in out)) {
    out[node.resourceId] = {
      resourceId: node.resourceId,
      role: node.className,
      text: node.text,
      firstSeen: nowIso,
      lastSeen: nowIso,
      tapped: false,
      outcomes: [],
    };
  }
  for (const child of node.children) {
    walkForElements(child, out, nowIso);
  }
}

/**
 * Update the acted-on element's `tapped` flag and outcome tally on the origin
 * screen. No-op for actions without an element id. Outcomes are keyed by
 * `(action.kind, ledToScreen)` so repeats collapse into a count.
 */
export function recordActionOutcome(
  state: SessionState,
  screenFp: Fingerprint,
  action: Action,
  outcomeFp: Fingerprint | null,
): void {
  const elementId = actionElementId(action);
  if (elementId === null) return;
  const screen = state.screens[screenFp];
  if (!screen) return;
  const element = screen.elements[elementId];
  if (!element) return;
  element.tapped = true;
  element.lastSeen = new Date().toISOString();
  const existing = element.outcomes.find(
    (o) => o.action === action.kind && o.ledToScreen === outcomeFp,
  );
  if (existing) {
    existing.count += 1;
  } else {
    element.outcomes.push({ action: action.kind, ledToScreen: outcomeFp, count: 1 });
  }
}

/**
 * Stringify an Action for deny-list matching and transition keys. Format:
 *   tap:elementId / type:elementId / scrollTo:elementId / swipe:up / back / done:reason
 *
 * Used by both the deny-list checker (matches as a prefix so `'type:email'`
 * denies any text typed into `email`) and the app-map merger (which keys
 * transitions by `(from, via, to)` where `via` is this stringified form).
 */
export function stringifyAction(action: Action): string {
  switch (action.kind) {
    case 'tap':
    case 'type':
    case 'scrollTo':
      return `${action.kind}:${action.elementId}`;
    case 'tapAt':
      return `tapAt:${action.x},${action.y}`;
    case 'swipe':
      return `swipe:${action.direction}`;
    case 'back':
      return 'back';
    case 'done':
      return `done:${action.reason}`;
  }
}

export function actionElementId(action: Action): string | null {
  switch (action.kind) {
    case 'tap':
    case 'type':
    case 'scrollTo':
      return action.elementId;
    default:
      return null;
  }
}

/**
 * Rebuild the frontier slice for one screen from current in-memory state and
 * splice it back into `state.frontier`. Other screens' entries stay intact.
 * Called after each acted turn so newly-tapped elements drop in priority.
 */
export function refreshFrontierForScreen(
  state: SessionState,
  appMap: AppMap,
  screenFp: Fingerprint,
): void {
  const screen = state.screens[screenFp];
  if (!screen) return;
  const rebuilt = buildFrontier(screen, appMap, {
    currentRunId: state.runId,
    sessionScreens: state.screens,
  });
  state.frontier = mergeFrontier(state.frontier, rebuilt, screenFp);
}

export function mergeFrontier(
  existing: FrontierEntry[],
  newEntries: FrontierEntry[],
  screenFp: Fingerprint,
): FrontierEntry[] {
  const kept = existing.filter((e) => e.screenFp !== screenFp);
  return [...kept, ...newEntries];
}

export function frontierForScreen(
  frontier: FrontierEntry[],
  fp: Fingerprint,
): FrontierEntry[] {
  return frontier.filter((e) => e.screenFp === fp);
}

/**
 * Dispatch a validated `Action` onto the driver. `done` is handled by the
 * caller before reaching this helper. Any driver error bubbles up to the
 * caller's catch.
 */
export async function dispatchAction(driver: Driver, action: Action): Promise<void> {
  switch (action.kind) {
    case 'tap':
      return driver.tap(action.elementId);
    case 'tapAt':
      return driver.tapAt(action.x, action.y);
    case 'type':
      return driver.type(action.elementId, action.text);
    case 'swipe':
      return driver.swipe(action.direction);
    case 'back':
      return driver.back();
    case 'scrollTo':
      return driver.scrollTo(action.elementId);
    case 'done':
      return;
  }
}

/**
 * Try one `relaunchApp()`, then poll `isAppAlive` for up to ~3s to give Android
 * time to bring the freshly-activated app back to the foreground.
 */
export async function tryRecoverDevice(driver: Driver): Promise<boolean> {
  try {
    await driver.relaunchApp();
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (await driver.isAppAlive()) return true;
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

/** `isAppAlive` with a swallowed exception — absence of a truthy result == dead. */
export async function safeIsAppAlive(driver: Driver): Promise<boolean> {
  try {
    return await driver.isAppAlive();
  } catch {
    return false;
  }
}
