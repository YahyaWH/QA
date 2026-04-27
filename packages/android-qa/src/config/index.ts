const DEFAULTS = {
  AGENT_MODEL: 'claude-opus-4-6',
  AGENT_VISION_EVERY_N_TURNS: '10',
  AGENT_WALL_CLOCK_MIN: '30',
  AGENT_TURN_BUDGET: '500',
  ANDROID_AVD_NAME: 'Pixel_7_API_34',
  APPIUM_HOST: '127.0.0.1',
  APPIUM_PORT: '4723',
  ARTIFACT_HOST_MODE: 'github-branch',
  ARTIFACT_GITHUB_BRANCH: 'android-qa-artifacts',
  DENY_ACTIONS: 'logout,sign-out,delete-account,delete-customer,delete-route,factory-reset',
} as const;

export interface Config {
  agent: {
    apiKey: string;
    model: string;
    wallClockMinutes: number;
    turnBudget: number;
    visionEveryNTurns: number;
    denyActions: string[];
  };
  device: {
    sdkRoot: string;
    avdName: string;
    apkPath: string;
    appiumHost: string;
    appiumPort: number;
  };
  auth: {
    roles: Record<string, { email: string; password: string }>;
  };
  publish: {
    linearTeamId?: string;
    linearProjectId?: string;
    artifactHostMode: 'github-branch' | 's3';
    artifactGithubBranch: string;
    artifactS3Bucket?: string;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const required = ['ANTHROPIC_API_KEY', 'ANDROID_SDK_ROOT', 'WASTEHERO_APK_PATH'];
  for (const k of required) {
    if (!env[k]) throw new Error(`Missing required env var: ${k}`);
  }
  const v = (k: keyof typeof DEFAULTS): string => env[k] ?? DEFAULTS[k];

  // Collect role credentials: WH_CREDS_<ROLE>_EMAIL + _PASSWORD
  const roles: Record<string, { email: string; password: string }> = {};
  for (const key of Object.keys(env)) {
    const m = key.match(/^WH_CREDS_([A-Z]+)_EMAIL$/);
    if (m) {
      const role = m[1].toLowerCase();
      const pw = env[`WH_CREDS_${m[1]}_PASSWORD`];
      if (pw) roles[role] = { email: env[key]!, password: pw };
    }
  }

  return {
    agent: {
      apiKey: env.ANTHROPIC_API_KEY!,
      model: v('AGENT_MODEL'),
      wallClockMinutes: parseInt(v('AGENT_WALL_CLOCK_MIN'), 10),
      turnBudget: parseInt(v('AGENT_TURN_BUDGET'), 10),
      visionEveryNTurns: parseInt(v('AGENT_VISION_EVERY_N_TURNS'), 10),
      denyActions: v('DENY_ACTIONS')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    device: {
      sdkRoot: env.ANDROID_SDK_ROOT!,
      avdName: v('ANDROID_AVD_NAME'),
      apkPath: env.WASTEHERO_APK_PATH!,
      appiumHost: v('APPIUM_HOST'),
      appiumPort: parseInt(v('APPIUM_PORT'), 10),
    },
    auth: { roles },
    publish: {
      linearTeamId: env.LINEAR_TEAM_ID,
      linearProjectId: env.LINEAR_PROJECT_ID,
      artifactHostMode: v('ARTIFACT_HOST_MODE') as 'github-branch' | 's3',
      artifactGithubBranch: v('ARTIFACT_GITHUB_BRANCH'),
      artifactS3Bucket: env.ARTIFACT_S3_BUCKET,
    },
  };
}
