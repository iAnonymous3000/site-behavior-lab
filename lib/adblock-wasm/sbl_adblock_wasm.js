/* @ts-self-types="./sbl_adblock_wasm.d.ts" */

/**
 * A compiled adblock engine, built once from newline-separated filter rules
 * (Brave / EasyList syntax) and then queried per network request.
 */
class AdblockEngine {
    static __wrap(ptr) {
        const obj = Object.create(AdblockEngine.prototype);
        obj.__wbg_ptr = ptr;
        AdblockEngineFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AdblockEngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_adblockengine_free(ptr, 0);
    }
    /**
     * Full `BlockerResult` query returning JSON with rule/list attribution,
     * exceptions, `$redirect` surrogate, `$removeparam` rewritten URL, and
     * both Brave Standard and Aggressive verdicts.
     * @param {string} url
     * @param {string} source_url
     * @param {string} request_type
     * @param {string} method
     * @returns {string}
     */
    checkDetailed(url, source_url, request_type, method) {
        let deferred5_0;
        let deferred5_1;
        try {
            let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3;
            try {
                ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                len0 = WASM_VECTOR_LEN;
                ptr1 = passStringToWasm0(source_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                len1 = WASM_VECTOR_LEN;
                ptr2 = passStringToWasm0(request_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                len2 = WASM_VECTOR_LEN;
                ptr3 = passStringToWasm0(method, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                len3 = WASM_VECTOR_LEN;
            } catch (e) {
                if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 1, 1); }
                if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
                if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
                if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
                throw e;
            }
            const ret = wasm.adblockengine_checkDetailed(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
            deferred5_0 = ret[0];
            deferred5_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * Method-aware network match for live routed requests. adblock-rust 0.13
     * added `$method=` filters, so the scanner must pass the browser's actual
     * method rather than silently treating POST/HEAD as GET.
     * @param {string} url
     * @param {string} source_url
     * @param {string} request_type
     * @param {string} method
     * @returns {boolean}
     */
    checkWithMethod(url, source_url, request_type, method) {
        let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3;
        try {
            ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(source_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(request_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len2 = WASM_VECTOR_LEN;
            ptr3 = passStringToWasm0(method, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len3 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 1, 1); }
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.adblockengine_checkWithMethod(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        return ret !== 0;
    }
    /**
     * Returns true if a request to `url` of `request_type`, initiated by
     * `source_url`, would be blocked by the loaded lists. Kept for offline
     * callers whose historical contract has GET semantics.
     * @param {string} url
     * @param {string} source_url
     * @param {string} request_type
     * @returns {boolean}
     */
    check(url, source_url, request_type) {
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(source_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(request_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.adblockengine_check(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        return ret !== 0;
    }
    /**
     * Build a full-telemetry engine with `FilterSet::new(true)` so every
     * `checkDetailed` query reports the matched filter rule, originating list
     * URL, line number, exception rule, `$redirect` surrogate, `$removeparam`
     * rewritten URL, and Brave Standard vs. Aggressive blocking verdicts.
     * @param {string} rules
     * @returns {AdblockEngine}
     */
    static newWithDebug(rules) {
        const ptr0 = passStringToWasm0(rules, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.adblockengine_newWithDebug(ptr0, len0);
        return AdblockEngine.__wrap(ret);
    }
    /**
     * Build a compact engine from newline-separated filter list rules
     * (debug metadata off; kept for low-memory / legacy boolean callers).
     * @param {string} rules
     */
    constructor(rules) {
        const ptr0 = passStringToWasm0(rules, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.adblockengine_new(ptr0, len0);
        this.__wbg_ptr = ret;
        AdblockEngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Number of distinct source lists indexed when constructed with `newWithDebug`.
     * @returns {number}
     */
    sourceCount() {
        const ret = wasm.adblockengine_sourceCount(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) AdblockEngine.prototype[Symbol.dispose] = AdblockEngine.prototype.free;
exports.AdblockEngine = AdblockEngine;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./sbl_adblock_wasm_bg.js": import0,
    };
}

const AdblockEngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_adblockengine_free(ptr, 1));

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
function decodeText(bytes) {
    return cachedTextDecoder.decode(bytes);
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/sbl_adblock_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
