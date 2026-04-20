export type Fingerprint = string; // 16-hex SHA-1 prefix

export type Category = 'A' | 'B' | 'C' | 'D' | 'E';
export type Severity = 'low' | 'med' | 'high' | 'critical';
export type RunStatus =
  | 'completed'
  | 'aborted-crash-loop'
  | 'aborted-device'
  | 'aborted-auth'
  | 'aborted-error';
export type FindingStatus =
  | 'new'
  | 'previously-seen'
  | 'resurrected'
  | 'published'
  | 'stale';

export interface ViewNode {
  resourceId: string | null;
  className: string;
  text: string | null;
  contentDesc: string | null;
  bounds: { x: number; y: number; w: number; h: number };
  clickable: boolean;
  enabled: boolean;
  visible: boolean;
  children: ViewNode[];
}

export interface Screen {
  fingerprint: Fingerprint;
  activity: string;
  elements: Record<string, ViewElement>;
}

export interface ViewElement {
  resourceId: string;
  role: string;
  text: string | null;
  firstSeen: string;
  lastSeen: string;
  tapped: boolean;
  outcomes: Array<{ action: string; ledToScreen: Fingerprint | null; count: number; note?: string }>;
  marked?: 'broken' | 'deny-listed';
}

export type Action =
  | { kind: 'tap'; elementId: string }
  | { kind: 'type'; elementId: string; text: string }
  | { kind: 'swipe'; direction: 'up' | 'down' | 'left' | 'right' }
  | { kind: 'back' }
  | { kind: 'scrollTo'; elementId: string }
  | { kind: 'done'; reason: string };

export interface Finding {
  id: string;
  runId: string;
  screenFp: Fingerprint;
  element: string | null;
  category: Category;
  severity: Severity;
  summary: string;
  reasoning: string;
  firstSeenRun?: string;
  lastSeenRun?: string;
  occurrences?: number;
  status: FindingStatus;
  linearIssueId?: string;
  artifactRefs?: { screenshot?: string; video?: string; logcat?: string };
}

export interface SessionState {
  runId: string;
  appVersion: string;
  role: string;
  startedAt: string;
  endedAt?: string;
  status?: RunStatus;
  budget: { wallClockMs: number; turns: number };
  counters: { crashCount: number; noNewScreenStreak: number; malformedJsonCount: number };
  screens: Record<Fingerprint, Screen>;
  frontier: Array<{ screenFp: Fingerprint; elementId: string; priority: number }>;
  findings: Finding[];
  history: Array<{ turn: number; screenFp: Fingerprint; action: Action; outcomeFp: Fingerprint | null; ms: number }>;
}

export interface AppMap {
  appVersion: string;
  generatedAt: string;
  schemaVersion: 1;
  screens: Record<Fingerprint, PersistedScreen>;
  transitions: Array<{ from: Fingerprint; via: string; to: Fingerprint; occurrences: number }>;
  /**
   * Run IDs already folded into this map. `mergeRunIntoMap` guards on this set
   * so calling it twice with the same `SessionState` is a no-op, which keeps
   * screen `seenCount` and transition `occurrences` idempotent.
   */
  mergedRunIds?: string[];
}

export interface PersistedScreen extends Screen {
  firstSeenRun: string;
  lastSeenRun: string;
  seenCount: number;
}
