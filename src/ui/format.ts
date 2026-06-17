export function fmt(n: number, digits = 0): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Signed rate, e.g. "+12.4/s" or "-3.0/s". */
export function rate(n: number): string {
  const sign = n > 0.05 ? '+' : n < -0.05 ? '' : '±';
  return `${sign}${n.toFixed(1)}/s`;
}

export function netClass(n: number): string {
  if (n > 0.05) return 'pos';
  if (n < -0.05) return 'neg';
  return 'zero';
}
