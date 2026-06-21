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

/** Compact duration, e.g. "12s" or "1m 5s". */
export function secs(n: number): string {
  const s = Math.max(0, Math.ceil(n));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Health-bar colour by level: healthy green → warning amber → critical red. */
export function healthColor(hp: number): string {
  if (hp < 25) return '#ff6b6b';
  if (hp < 50) return '#e0b341';
  return '#6fcf97';
}
