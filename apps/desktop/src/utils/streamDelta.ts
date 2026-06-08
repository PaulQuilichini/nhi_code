/**
 * Merge a streaming text/thinking chunk into an accumulated buffer.
 * Handles incremental deltas, cumulative deltas (full text so far), and duplicate chunks.
 */
export function applyStreamDelta(buffer: string, delta: string): string {
  if (!delta) return buffer;
  if (!buffer) return delta;

  // API resent the full text accumulated so far (cumulative streaming).
  if (delta.length >= buffer.length && delta.startsWith(buffer)) {
    return delta;
  }

  // Exact duplicate of the entire buffer.
  if (delta === buffer) return buffer;

  // Duplicate incremental chunk (common when events are delivered twice).
  if (buffer.endsWith(delta)) return buffer;

  // Cumulative chunk that repeats then extends (buffer already ends with overlap).
  if (delta.startsWith(buffer)) return delta;

  return buffer + delta;
}

export function emptyStreamBuffers(): { text: string; thinking: string } {
  return { text: "", thinking: "" };
}
