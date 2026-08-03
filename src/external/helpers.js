export function getFunctionBody(fn) {
    const str = fn.toString();
    return str.substring(str.indexOf('{') + 1, str.lastIndexOf('}')).trim();
}

export const idify = (text) => {
    if (!text) return '';

    return btoa(text + Math.random(100 * 9999) * 100)
        .toString()
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
};