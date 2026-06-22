import { SEASON_LENGTH } from '../sim/config';
export function fmt(n, digits = 0) {
    return n.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
}
/** Signed rate shown per season, from a per-second value, e.g. "+12.4/season". */
export function rate(n) {
    const perSeason = n * SEASON_LENGTH;
    const sign = perSeason > 0.5 ? '+' : perSeason < -0.5 ? '' : '±';
    return `${sign}${perSeason.toFixed(0)}/season`;
}
export function netClass(n) {
    const perSeason = n * SEASON_LENGTH;
    if (perSeason > 0.5)
        return 'pos';
    if (perSeason < -0.5)
        return 'neg';
    return 'zero';
}
/** Compact duration, e.g. "12s" or "1m 5s". */
export function secs(n) {
    const s = Math.max(0, Math.ceil(n));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
/** Approximate length in whole seasons, e.g. "Less than a season", "1 season", "2 seasons". */
export function seasonsLabel(seconds) {
    if (seconds < SEASON_LENGTH)
        return 'Less than a season';
    const n = Math.round(seconds / SEASON_LENGTH);
    return `${n} season${n === 1 ? '' : 's'}`;
}
/** Health-bar colour by level: healthy green → warning amber → critical red. */
export function healthColor(hp) {
    if (hp < 25)
        return '#ff6b6b';
    if (hp < 50)
        return '#e0b341';
    return '#6fcf97';
}
