/**
 * One place for the app's magic timings (audit B8 — they were scattered
 * as inline literals: the 240s prompt budget and the A-L6/A-O9 poll caps).
 */

export const TIMINGS = {
  /** Agent prompt budget; a stuck agent surfaces an error instead of hanging. */
  promptTimeoutMs: 240_000,
  /** A-O9: wait for the switched document to become active after /activate. */
  documentSwitchPollMs: 2_000,
  /** pollUntil() cadence. */
  pollIntervalMs: 50,
  /** Bridge HTTP request timeout. */
  bridgeRequestTimeoutMs: 40_000,
  /** Track D: one bridge /events long-poll per session (its window). */
  eventPollMs: 25_000,
  /** Track D: retry pause after a failed events long-poll (bridge down). */
  eventRetryMs: 5_000,
} as const;
