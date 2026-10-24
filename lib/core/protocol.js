// @generated from src/protocol.ts by scripts/port-core.mjs — do not edit by hand.
import { gzipSync, gunzipSync } from 'node:zlib';
import { Writer, decode, stringField } from './protobuf.js';
import { fail, json, object } from './safety.js';
export const JWT_PATH = '/exa.auth_pb.AuthService/GetUserJwt';
export const STREAM_PATH = '/exa.api_server_pb.ApiServerService/GetDevstralStream';
export const MODEL = 'swe-1-6-fast';
export function metadata(token, jwt) {
    const w = new Writer().string(1, 'windsurf').string(2, '1.48.2').string(3, token).string(4, 'en').string(7, '3.2.23').string(12, 'windsurf');
    if (jwt) w.string(21, jwt);
    return w.build();
}
export const jwtRequest = (token)=>new Writer().bytes(1, metadata(token)).build();
export const jwtResponse = (payload)=>stringField(decode(payload), 1);
export function chatRequest(token, jwt, system, messages, tools) {
    const encode = (role, content, call, callId)=>{
        const w = new Writer().int(2, role).string(3, content);
        if (call) w.bytes(6, new Writer().string(1, call.id).string(2, call.name).string(3, JSON.stringify(call.args)).build());
        if (callId) w.string(7, callId);
        return w.build();
    };
    const w = new Writer().bytes(1, metadata(token, jwt)).bytes(2, encode(5, system));
    for (const m of messages)w.bytes(2, encode({
        user: 1,
        assistant: 2,
        tool: 4
    }[m.role], m.content, m.call, m.callId));
    return w.string(3, tools).build();
}
export function frame(payload, flags = 0) {
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([
        header,
        payload
    ]);
}
export const gzipFrame = (payload)=>frame(gzipSync(payload), 1);
export function streamText(buffer, cap = 1024 * 1024) {
    if (buffer.length > 4 * 1024 * 1024) return fail('bounds', 'Devin stream byte budget exceeded.');
    let offset = 0;
    let text = '';
    let trailer = false;
    let decodedBytes = 0;
    while(offset < buffer.length){
        if (trailer || offset + 5 > buffer.length) return fail('protocol', 'Partial or trailing Devin stream frame.');
        const flags = buffer[offset];
        const length = buffer.readUInt32BE(offset + 1);
        offset += 5;
        if (flags & ~3 || length > cap || offset + length > buffer.length) return fail('protocol', 'Invalid or partial Devin stream frame.');
        let payload = buffer.subarray(offset, offset + length);
        offset += length;
        if (flags & 1) {
            try {
                payload = gunzipSync(payload, {
                    maxOutputLength: cap
                });
            } catch  {
                return fail('protocol', 'Invalid or oversized Devin gzip frame.');
            }
        }
        decodedBytes += payload.length;
        if (decodedBytes > cap) return fail('bounds', 'Devin decoded stream budget exceeded.');
        if (flags & 2) {
            trailer = true;
            const value = object(json(payload));
            if (!value) return fail('protocol', 'Malformed Devin stream trailer.');
            if (value.error) return fail('protocol', 'Devin stream reported an error.');
        } else {
            const fields = decode(payload);
            text += stringField(fields, 2) ?? stringField(fields, 3) ?? '';
        }
    }
    if (!trailer) return fail('protocol', 'Devin stream ended without a trailer.');
    return text.replace(/<\/s>\s*$/, '');
}
export function toolMarker(text) {
    const index = text.indexOf('[TOOL_CALLS]');
    if (index < 0) return;
    const rest = text.slice(index + 12).trim();
    const marker = /^([a-zA-Z_]{1,64})\s*(?:\[ARGS\]\s*)?(?=\{)/.exec(rest);
    if (!marker) return fail('protocol', 'Malformed Devin tool marker.');
    const name = marker[1];
    const raw = rest.slice(marker[0].length).trim().replace(/<\/s>\s*$/, '');
    const args = object(json(Buffer.from(raw)));
    if (!args) return fail('protocol', 'Invalid Devin tool arguments.');
    return {
        name,
        args
    };
}
