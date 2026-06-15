export function formatMoney(value?: number | null) {
  if (value === undefined || value === null) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

export function formatPercent(value?: number | null) {
  if (value === undefined || value === null) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}
