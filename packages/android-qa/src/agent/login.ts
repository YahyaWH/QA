import type { Driver } from '../device/driver';
import type { Fingerprint, ViewNode } from '../types/index';
import { fingerprintFromTree } from './fingerprint';

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface LoginOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  activityOverride?: string;
}

/**
 * Raised when the login flow cannot complete: a required form element is missing,
 * the submit button has no resource-id to tap, or the UI does not change after
 * submission within `timeoutMs`.
 */
export class LoginFailedError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'LoginFailedError';
  }
}

/**
 * Drive a `Driver` through a login form.
 *
 * Locates the email/password EditTexts and the submit Button on the current
 * screen via case-insensitive resource-id / text heuristics, types the
 * credentials, taps submit, then polls the view tree until the screen
 * fingerprint changes (indicating a successful navigation). Returns the new
 * fingerprint so the caller can index it into the app map.
 *
 * @throws {LoginFailedError} if any of the three form elements cannot be found,
 * if the submit element has no resource-id (Driver.tap requires one), or if no
 * tree change is observed within `timeoutMs`.
 */
export async function login(
  driver: Driver,
  creds: LoginCredentials,
  opts?: LoginOptions,
): Promise<Fingerprint> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 250;

  // The app renders asynchronously (splash → React Native bundle → login form),
  // so the login form may not be present on the first page-source dump even
  // when the tree parses fine. Poll until the email field appears or the
  // tree stabilizes without one (in which case we're on the wrong screen).
  const tree = await waitForLoginForm(driver, 30_000, pollIntervalMs);

  const emailNode = findEmailField(tree);
  if (!emailNode || !emailNode.resourceId) {
    // waitForLoginForm only returns a tree where findEmailField matched, so
    // this branch is defensive against a missing resource-id.
    throw new LoginFailedError('email field found but has no resource-id');
  }

  const passwordNode = findPasswordField(tree);
  if (!passwordNode || !passwordNode.resourceId) {
    throw new LoginFailedError('password field not found');
  }

  const submitNode = findSubmitButton(tree);
  if (!submitNode) {
    throw new LoginFailedError('submit button not found');
  }
  if (!submitNode.resourceId) {
    throw new LoginFailedError('submit button has no resource-id (cannot be tapped)');
  }

  const activity = opts?.activityOverride ?? (await driver.getCurrentActivity());
  const initialFp = fingerprintFromTree(tree, activity);

  await driver.type(emailNode.resourceId, creds.email);
  await driver.type(passwordNode.resourceId, creds.password);
  await driver.tap(submitNode.resourceId);

  const deadline = Date.now() + timeoutMs;
  // One immediate probe before the first sleep, plus subsequent polls at pollIntervalMs.
  while (true) {
    const newTree = await driver.getViewTree();
    const newActivity = opts?.activityOverride ?? (await driver.getCurrentActivity());
    const fp = fingerprintFromTree(newTree, newActivity);
    if (fp !== initialFp) return fp;

    if (Date.now() >= deadline) {
      throw new LoginFailedError('tree did not change after login submit');
    }
    await sleep(pollIntervalMs);
  }
}

function findEmailField(tree: ViewNode): ViewNode | null {
  // Priority order: email > username > login. Skip button-classed elements so we
  // don't match a "Log in" button when looking for a "login" text field.
  const candidates = [/email/i, /username/i, /login/i];
  for (const re of candidates) {
    const match = findFirst(tree, (n) => {
      if (!n.resourceId) return false;
      if (!re.test(n.resourceId)) return false;
      if (n.className.toLowerCase().includes('button')) return false;
      return true;
    });
    if (match) return match;
  }
  return null;
}

function findPasswordField(tree: ViewNode): ViewNode | null {
  return findFirst(tree, (n) => {
    if (!n.resourceId) return false;
    return /password/i.test(n.resourceId);
  });
}

function findSubmitButton(tree: ViewNode): ViewNode | null {
  const submitRe = /sign.?in|log.?in|submit/i;
  // Prefer a clickable element whose resource-id matches.
  const byId = findFirst(tree, (n) => {
    if (!n.clickable) return false;
    if (!n.resourceId) return false;
    return submitRe.test(n.resourceId);
  });
  if (byId) return byId;

  // Fall back to a clickable element whose visible text matches.
  const byText = findFirst(tree, (n) => {
    if (!n.clickable) return false;
    if (!n.text) return false;
    return submitRe.test(n.text);
  });
  return byText;
}

function collectResourceIds(tree: ViewNode): string[] {
  const result: string[] = [];
  function walk(n: ViewNode): void {
    if (n.resourceId) result.push(n.resourceId);
    for (const c of n.children) walk(c);
  }
  walk(tree);
  return result;
}

function findFirst(tree: ViewNode, predicate: (n: ViewNode) => boolean): ViewNode | null {
  if (predicate(tree)) return tree;
  for (const child of tree.children) {
    const hit = findFirst(child, predicate);
    if (hit) return hit;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when the only resource-ids in the tree are Android framework wrappers
 * (e.g. `android:id/content`, `<pkg>:id/action_bar_root`) — i.e. the system
 * has created the activity shell but the app's own UI (React Native bundle,
 * Jetpack Compose root, etc.) has not mounted yet. On slower renderers like
 * Win11 + swiftshader_indirect, this "shell only" state can persist for
 * several seconds between driver-session creation and the login form
 * appearing. Treating such a tree as stable would abort waitForLoginForm
 * before the app had a chance to render.
 */
function isLoadingShell(tree: ViewNode): boolean {
  const ids = collectResourceIds(tree);
  if (ids.length === 0) return true;
  const wrapperRe = /^(android:id\/content|[^:]+:id\/(action_bar_root|action_mode_bar_stub|action_bar_container))$/;
  return ids.every((id) => wrapperRe.test(id));
}

/**
 * Poll the view tree until an email/username field is visible (signaling the
 * login form has rendered) or the tree settles on a non-login state.
 *
 * Termination:
 * - Email field found → return the tree.
 * - Tree fingerprint unchanged across two consecutive polls AND tree has
 *   app-mounted content (not just framework wrappers) AND no email field
 *   → throw immediately. We're on the wrong screen and staying there.
 * - `timeoutMs` elapsed → throw with the last observed activity + resource ids.
 *
 * "Loading shell" trees (only `android:id/content` + `<pkg>:id/action_bar_root`
 * style wrappers) are ignored for stability counting — they're the pre-mount
 * state that Win11 + swiftshader renders slowly through, and bailing out of
 * them as "stable + no email" was the cause of v2.4.0-rc.7 aborted-auth runs.
 *
 * Parse errors (e.g. `<hierarchy/>` during app launch) are tolerated and
 * retried until the timeout.
 */
async function waitForLoginForm(
  driver: Driver,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ViewNode> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let lastFp: string | null = null;
  let lastTree: ViewNode | null = null;
  let lastActivity = 'unknown';
  let stableCount = 0;

  while (true) {
    let tree: ViewNode | null = null;
    try {
      tree = await driver.getViewTree();
    } catch (err) {
      lastError = err;
    }

    if (tree) {
      if (findEmailField(tree)) return tree;
      lastTree = tree;
      lastActivity = await driver.getCurrentActivity().catch(() => 'unknown');

      if (isLoadingShell(tree)) {
        lastFp = null;
        stableCount = 0;
      } else {
        const fp = fingerprintFromTree(tree, lastActivity);
        if (fp === lastFp) {
          stableCount += 1;
          if (stableCount >= 2) {
            const ids = collectResourceIds(tree).slice(0, 20).join(',');
            throw new LoginFailedError(
              `email field not found (activity=${lastActivity}, firstIds=${ids})`,
            );
          }
        } else {
          lastFp = fp;
          stableCount = 0;
        }
      }
    }

    if (Date.now() >= deadline) {
      const ids = lastTree ? collectResourceIds(lastTree).slice(0, 20).join(',') : '';
      const suffix = lastError instanceof Error ? ` (lastError=${lastError.message})` : '';
      throw new LoginFailedError(
        `login form did not appear within ${timeoutMs}ms (activity=${lastActivity}, firstIds=${ids})${suffix}`,
      );
    }
    await sleep(pollIntervalMs);
  }
}
