// @generated from src/oauth.ts by scripts/port-core.mjs — do not edit by hand.
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { abortable, boundedBody, check, deadline, fail, json, object, request } from './safety.js';
const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store'
};
function send(res, status, body, type = 'text/plain') {
    res.writeHead(status, {
        'content-type': type,
        ...CORS
    }).end(body);
}
async function closeServer(server) {
    await new Promise((resolve)=>{
        server.close(()=>resolve());
        server.closeAllConnections();
    });
}
export async function oauthCode(signal, notify, prompt, options = {}) {
    const life = deadline(signal, options.timeoutMs ?? 300_000);
    check(life);
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL('/auth/cli/continue', options.webBase ?? 'https://app.devin.ai');
    url.search = new URLSearchParams({
        state: randomBytes(32).toString('base64url'),
        prompt: 'select_account',
        code_challenge: challenge,
        code_challenge_method: 'S256'
    }).toString();
    notify(url.toString());
    const code = validateCode(await abortable(prompt(life), life));
    check(life);
    return exchangeCode(code, verifier, life, options);
}
export function validateCode(value) {
    if (typeof value !== 'string' || value.length > 8192) return fail('bounds', 'Invalid Devin authorization code.');
    const code = value.trim();
    if (!code || /[\s\x00-\x1f\x7f]/.test(code)) return fail('bounds', 'Invalid Devin authorization code.');
    return code;
}
async function exchangeCode(code, verifier, signal, options) {
    const response = await request(new URL('/auth/cli/token', options.apiBase ?? 'https://api.devin.ai').toString(), {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json'
        },
        body: JSON.stringify({
            code,
            code_verifier: verifier
        })
    }, signal, options.fetcher);
    if (!response.ok) {
        await response.body?.cancel();
        return fail('network', 'Devin token exchange failed. Please retry login.');
    }
    const data = object(json(await boundedBody(response, signal, 64 * 1024)));
    if (typeof data?.token !== 'string' || !data.token || data.token.length > 16_384) return fail('protocol', 'Devin token exchange returned no valid session.');
    return data.token;
}
export async function oauth(signal, notify, options = {}) {
    const life = deadline(signal, options.timeoutMs ?? 300_000);
    check(life);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let resolveCode;
    let accepted = false;
    const codeReady = new Promise((resolve)=>{
        resolveCode = resolve;
    });
    let phase = 'pending';
    let holdReleased = false;
    let releaseHold;
    const hold = new Promise((resolve)=>{
        releaseHold = resolve;
    });
    const mark = (next)=>{
        if (phase === 'pending') phase = next;
    };
    const noteStatusRead = ()=>{
        if (phase === 'pending' || holdReleased) return;
        holdReleased = true;
        releaseHold();
    };
    const server = createServer((req, res)=>{
        let url;
        try {
            url = new URL(req.url ?? '/', 'http://127.0.0.1');
        } catch  {
            send(res, 400, 'Bad request.');
            return;
        }
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                ...CORS,
                'access-control-max-age': '600'
            }).end();
            return;
        }
        if (req.method === 'GET' && url.pathname === '/status') {
            if (phase !== 'pending') noteStatusRead();
            send(res, 200, JSON.stringify({
                phase
            }), 'application/json');
            return;
        }
        if (req.method !== 'GET' || url.pathname !== '/callback') {
            send(res, 404, 'Not found.');
            return;
        }
        const got = Buffer.from(url.searchParams.get('state') ?? '');
        const want = Buffer.from(state);
        const code = url.searchParams.get('code');
        if (accepted || !code || code.length > 8192 || got.length !== want.length || !timingSafeEqual(got, want)) {
            send(res, 400, 'Invalid callback.');
            return;
        }
        accepted = true;
        resolveCode(code);
        send(res, 200, 'Callback accepted. Return to DSH — the login card updates automatically.');
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    let closed = false;
    let statusHoldScheduled = false;
    const closeNow = ()=>{
        if (closed) return;
        closed = true;
        server.close();
        server.closeAllConnections();
    };
    const holdStatusThenClose = ()=>{
        if (statusHoldScheduled || closed) return;
        statusHoldScheduled = true;
        const holdMs = options.statusHoldMs ?? 15_000;
        void (async ()=>{
            try {
                await Promise.race([
                    hold,
                    new Promise((resolve)=>{
                        setTimeout(resolve, holdMs);
                    })
                ]);
            } finally{
                if (!closed) await closeServer(server);
                closed = true;
            }
        })();
    };
    const onAbort = ()=>{
        mark('cancelled');
        closeNow();
    };
    life.addEventListener('abort', onAbort, {
        once: true
    });
    try {
        try {
            await listen(server, options.port ?? 59653, life);
        } catch (error) {
            check(life);
            if (error.code !== 'EADDRINUSE') return fail('network', 'Unable to start Devin loopback callback.');
            await listen(server, 0, life);
        }
        check(life);
        const address = server.address();
        if (!address || typeof address === 'string') return fail('network', 'Devin callback was not bound.');
        const url = new URL('/auth/cli/continue', options.webBase ?? 'https://app.devin.ai');
        url.search = new URLSearchParams({
            state,
            redirect_uri: `http://127.0.0.1:${address.port}/callback`,
            prompt: 'select_account',
            code_challenge: challenge,
            code_challenge_method: 'S256'
        }).toString();
        notify(url.toString());
        const code = await abortable(codeReady, life);
        check(life);
        const token = await exchangeCode(code, verifier, life, options);
        mark('authorized');
        holdStatusThenClose();
        return token;
    } catch (error) {
        if (phase === 'pending') mark(life.aborted ? 'cancelled' : 'error');
        if (!closed && phase !== 'pending') holdStatusThenClose();
        else if (!closed) closeNow();
        throw error;
    } finally{
        life.removeEventListener('abort', onAbort);
    }
}
async function listen(server, port, signal) {
    check(signal);
    await abortable(new Promise((resolve, reject)=>{
        const error = (e)=>{
            server.removeListener('listening', ready);
            reject(e);
        };
        const ready = ()=>{
            server.removeListener('error', error);
            resolve();
        };
        server.once('error', error);
        server.once('listening', ready);
        server.listen(port, '127.0.0.1');
    }), signal);
}
