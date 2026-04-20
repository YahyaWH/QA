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

  const tree = await driver.getViewTree();

  const emailNode = findEmailField(tree);
  if (!emailNode || !emailNode.resourceId) {
    throw new LoginFailedError('email field not found');
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
