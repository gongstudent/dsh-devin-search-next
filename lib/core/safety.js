// @generated from src/safety.ts by scripts/port-core.mjs — do not edit by hand.
export class DevinError extends Error {
    code;
    constructor(code, message){
        super(message), this.code = code;
        this.name = 'DevinError';
    }
}
export const fail = (code, message)=>{
    throw new DevinError(code, message);
};
export function check(signal) {
    if (signal.aborted) fail('cancelled', 'Devin operation cancelled or timed out.');
}
export function safeError(error) {
    return error instanceof DevinError ? error.message : 'Devin operation failed. No provider details were retained.';
}
export function deadline(signal, ms) {
    return AbortSignal.any([
        ...signal ? [
            signal
        ] : [],
        AbortSignal.timeout(ms)
    ]);
}
export async function abortable(promise, signal) {
    if (signal.aborted) {
        void promise.catch(()=>{});
        check(signal);
    }
    return new Promise((resolve, reject)=>{
        const abort = ()=>reject(new DevinError('cancelled', 'Devin operation cancelled or timed out.'));
        signal.addEventListener('abort', abort, {
            once: true
        });
        promise.then(resolve, reject).finally(()=>signal.removeEventListener('abort', abort)).catch(()=>{});
    });
}
export async function boundedBody(response, signal, cap = 2 * 1024 * 1024) {
    if (signal.aborted) {
        await response.body?.cancel().catch(()=>{});
        check(signal);
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    const cancel = ()=>{
        void reader.cancel().catch(()=>{});
    };
    signal.addEventListener('abort', cancel, {
        once: true
    });
    try {
        while(true){
            check(signal);
            const { done, value } = await abortable(reader.read(), signal);
            check(signal);
            if (done) break;
            bytes += value.length;
            if (bytes > cap) fail('bounds', 'Devin response exceeded the byte budget.');
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks);
    } finally{
        signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(()=>{});
        reader.releaseLock();
    }
}
export async function request(url, init, signal, fetcher = fetch) {
    check(signal);
    try {
        const pending = fetcher(url, {
            ...init,
            signal,
            redirect: 'error'
        }).then(async (response)=>{
            if (signal.aborted) {
                await response.body?.cancel().catch(()=>{});
                check(signal);
            }
            return response;
        });
        return await abortable(pending, signal);
    } catch  {
        check(signal);
        return fail('network', 'Devin network request failed.');
    }
}
export const DEVIN_SESSION_TOKEN_PREFIX = 'devin-session-token$';
export const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;
export function toDevinSessionToken(token) {
    const raw = token.trim();
    if (!raw) return raw;
    if (raw.startsWith(DEVIN_SESSION_TOKEN_PREFIX) || raw.startsWith('sk-ws-')) return raw;
    return `${DEVIN_SESSION_TOKEN_PREFIX}${raw}`;
}
export function expiry(token, now = Date.now()) {
    try {
        const body = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
        if (typeof body.exp === 'number' && Number.isFinite(body.exp) && body.exp > 0) {
            return {
                expiresAt: body.exp * 1000 - 60_000,
                expirySource: 'jwt'
            };
        }
    } catch  {}
    return {
        expiresAt: now + FALLBACK_EXPIRES_MS,
        expirySource: 'fallback'
    };
}
export function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
export function json(buffer) {
    try {
        return JSON.parse(buffer.toString('utf8'));
    } catch  {
        return fail('protocol', 'Invalid Devin JSON response.');
    }
}
export function sessionSecrets(token) {
    const out = new Set();
    const raw = token.trim();
    if (!raw) return [];
    out.add(raw);
    out.add(toDevinSessionToken(raw));
    if (raw.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) out.add(raw.slice(DEVIN_SESSION_TOKEN_PREFIX.length));
    return [
        ...out
    ].filter(Boolean);
}
export function redact(text, secrets) {
    const all = new Set();
    for (const secret of secrets)for (const part of sessionSecrets(secret))all.add(part);
    for (const secret of [
        ...all
    ].sort((a, b)=>b.length - a.length)){
        if (secret) text = text.split(secret).join('[redacted]');
    }
    return text;
}
