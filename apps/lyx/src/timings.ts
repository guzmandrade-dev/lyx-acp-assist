/**
 * One place for the app's magic timings (they were scattered
 * as inline literals before: 240s prompts, 8s pipe, 500ms deaf probe,
 * 150/600ms write-only graces, poll caps).
 */

export const TIMINGS = {
  /** Agent prompt budget; a stuck agent surfaces an error instead of hanging. */
  promptTimeoutMs: 240_000,
  /** One LFUN round-trip before "No reply from LyX". */
  pipeTimeoutMs: 8_000,
  /** start()'s probe window deciding pipe vs. write-only mode. */
  deafProbeMs: 500,
  /** Write-only mode: blind-command grace (file ops use 4x, see graceFor). */
  writeOnlyGraceMs: 150,
  /** Wait for the x-lyx payload to appear after a copy LFUN. */
  clipboardPayloadPollMs: 500,
  /** Wait for the switched document to become active. */
  documentSwitchPollMs: 2_000,
  /** pollUntil() cadence. */
  pollIntervalMs: 25,
} as const;
