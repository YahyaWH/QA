import { describe, it, expect } from 'vitest';
import { loadConfig } from './index';

describe('loadConfig', () => {
  it('throws on missing ANTHROPIC_API_KEY', () => {
    expect(() => loadConfig({})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('returns defaults for optional values', () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: 'x',
      ANDROID_SDK_ROOT: '/sdk',
      WASTEHERO_APK_PATH: '/apk',
    });
    expect(cfg.agent.model).toBe('claude-opus-4-7');
    expect(cfg.agent.wallClockMinutes).toBe(30);
    expect(cfg.agent.visionEveryNTurns).toBe(10);
    expect(cfg.device.avdName).toBe('Pixel_7_API_34');
    expect(cfg.publish.artifactHostMode).toBe('github-branch');
  });

  it('parses deny list as comma-separated', () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: 'x',
      ANDROID_SDK_ROOT: '/sdk',
      WASTEHERO_APK_PATH: '/apk',
      DENY_ACTIONS: 'logout,delete-account',
    });
    expect(cfg.agent.denyActions).toEqual(['logout', 'delete-account']);
  });

  it('collects role credentials', () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: 'x',
      ANDROID_SDK_ROOT: '/sdk',
      WASTEHERO_APK_PATH: '/apk',
      WH_CREDS_ADMIN_EMAIL: 'a@x',
      WH_CREDS_ADMIN_PASSWORD: 'p',
    });
    expect(cfg.auth.roles.admin).toEqual({ email: 'a@x', password: 'p' });
  });
});
