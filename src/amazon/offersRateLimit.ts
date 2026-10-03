let nextItemOffersBatchStartAt = 0;

/**
 * getCompetitiveSummary has a conservative default rate of 0.033 request/second.
 * The mobile routes and the background repricer share one slot so their
 * combined traffic stays inside Amazon's limit instead of producing 429s.
 */
export async function withItemOffersBatchSlot<T>(request: () => Promise<T>) {
  const now = Date.now();
  const startAt = Math.max(now, nextItemOffersBatchStartAt);
  nextItemOffersBatchStartAt = startAt + 30_000;

  if (startAt > now) {
    await new Promise<void>((resolve) => setTimeout(resolve, startAt - now));
  }

  return request();
}
