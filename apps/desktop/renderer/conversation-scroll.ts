/** Follow only when the reader is close to the end; never infer this from a turn status. */
export function nearConversationEnd(
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
  threshold = 80,
) {
  return (
    [
      metrics.scrollHeight,
      metrics.clientHeight,
      metrics.scrollTop,
      threshold,
    ].every(Number.isFinite) &&
    threshold >= 0 &&
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold
  );
}
