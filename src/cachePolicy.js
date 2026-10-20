export function getHeader(headers, name) {
    return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

function directive(cacheControl, name) {
    const part = (String(cacheControl).match(/(?:[^,"]|"[^"]*")+/g) || [])
        .find(part => part.trim().split('=', 1)[0].toLowerCase() === name);
    if (part === undefined) return undefined;
    const separator = part.indexOf('=');
    return separator < 0 ? true : part.slice(separator + 1).trim();
}

export function getLastModified(file) {
    const value = getHeader(file?.headers, 'last-modified') || file?.updated?.on || file?.created?.on;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? new Date(time).toUTCString() : undefined;
}

export function getCacheExpiry(input = {}, now = Date.now()) {
    const headers = typeof input === 'string' ? { 'cache-control': input } : input?.headers || input || {};
    const cc = getHeader(headers, 'cache-control') || '';
    const value = directive(cc, 'max-age');
    const maxAge = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
    let expires = Date.parse(getHeader(headers, 'expires'));
    if (value !== undefined) {
        const date = Date.parse(getHeader(headers, 'date'));
        const age = Number(getHeader(headers, 'age') || 0);
        expires = maxAge !== null && Number.isFinite(date) && Number.isFinite(age) && age >= 0
            ? now + maxAge * 1000 - Math.max(0, now - date, age * 1000) : NaN;
    }
    return {
        maxAge,
        expires: Number.isFinite(expires) ? expires : null,
        expired: !Number.isFinite(expires) || expires <= now ||
            directive(cc, 'no-cache') !== undefined || directive(cc, 'no-store') !== undefined
    };
}

// Recursive 304 is a client-render marker. HTTP 304 additionally requires a client validator.
export function getCachePolicy(file, { headers = {}, method = 'GET', recursive = false } = {}) {
    const cacheControl = String(typeof file === 'string' ? file : getHeader(file?.headers, 'cache-control') || '');
    const has = name => directive(cacheControl, name) !== undefined;
    const policy = has('must-revalidate') || has('proxy-revalidate') ? 'authorize'
        : has('private') ? 'authenticate' : has('public') ? 'public' : 'authorize';
    const freshness = getCacheExpiry(file);
    let status = 200;
    if (!has('no-store') && (method === 'GET' || method === 'HEAD')) {
        if (recursive) {
            if (!has('no-cache') && (has('immutable') || !freshness.expired)) status = 304;
        } else {
            const etag = getHeader(file?.headers, 'etag');
            const matches = getHeader(headers, 'if-none-match');
            if (typeof matches === 'string') {
                if (matches.trim() === '*' || (etag &&
                    (matches.match(/(?:W\/)?"[^"]*"/g) || []).some(tag => tag.replace(/^W\//, '') === String(etag).replace(/^W\//, '')))) status = 304;
            } else {
                const updated = Date.parse(getLastModified(file));
                const since = Date.parse(getHeader(headers, 'if-modified-since'));
                if (Number.isFinite(updated) && Number.isFinite(since) && updated <= since) status = 304;
            }
        }
    }
    return { cacheControl, policy, status, ...freshness };
}

// Included content must not inherit a less restrictive cache policy from its parent.
export function responseCacheControl(policies = []) {
    if (!policies.length) return 'no-store';
    if (policies.length === 1) return policies[0].cacheControl || 'no-store';
    const has = (p, name) => directive(p.cacheControl, name) !== undefined;
    if (policies.some(p => !p.cacheControl || has(p, 'no-store'))) return 'no-store';
    const parts = [policies.every(p => has(p, 'public') && !has(p, 'private')) ? 'public' : 'private'];
    const ages = policies.map(p => directive(p.cacheControl, 'max-age'));
    if (policies.some(p => has(p, 'no-cache')) || ages.some(age => typeof age !== 'string' || !/^\d+$/.test(age))) parts.push('no-cache');
    else {
        parts.push(`max-age=${Math.min(...ages.map(Number))}`);
        if (policies.every(p => has(p, 'immutable'))) parts.push('immutable');
    }
    for (const name of ['must-revalidate', 'proxy-revalidate']) if (policies.some(p => has(p, name))) parts.push(name);
    return parts.join(', ');
}
