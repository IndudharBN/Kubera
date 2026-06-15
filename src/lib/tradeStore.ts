/** Today's date in ET, as YYYY-MM-DD. */
export function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Trade's open date in ET, as YYYY-MM-DD. */
export function tradeDateET(trade: { openedAt: string }): string {
  if (!trade.openedAt) return '';
  return new Date(trade.openedAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
