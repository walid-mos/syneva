// Test-observability counters. `fileReads`: the number of times fileAt actually reads a
// blob/working file - buildReviewState must NOT read committed contents (issue 04), a pr-mode
// fixture asserts this stays 0 across a build. `parses`: the number of parseUnifiedDiff calls -
// a reload must parse the diff exactly once (issue 06), shared across build + rename detection.
// `readsInFlight`/`peakReadsInFlight`: the concurrent content reads, so a build that fans out over
// every file can be held to a bounded number of open descriptors (see content-reads.ts).
// Reset the relevant fields before the window you want to measure.
//
// Lives in domain (not the git adapter) so the pure diff parser can count its own parses without
// importing an adapter; the git adapter and content-reads share the same record.
export const gitStats = {
	fileReads: 0,
	parses: 0,
	readsInFlight: 0,
	peakReadsInFlight: 0,
}
