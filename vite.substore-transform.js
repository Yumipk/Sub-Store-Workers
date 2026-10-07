import path from 'node:path';
import { fileURLToPath } from 'node:url';
import peggy from 'peggy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SUB_STORE_PATH = path.join(__dirname, 'sub-store/backend');

export function subStoreTransformPlugin() {
    let expressPatchApplied = 0;
    let expressFileSeen = false;
    let openApiPatchApplied = 0;
    let openApiFileSeen = false;
    let downloadPatchApplied = 0;
    let downloadFileSeen = false;
    let processorsPatchApplied = 0;
    let processorsFileSeen = false;
    let openApiDebugPatchApplied = 0;
    let openApiDebugFileSeen = false;
    let rsPatchApplied = 0;
    let rsFileSeen = false;
    let subStoreFileSeen = false;

    const requiredTargetFiles = [
        ['express.js', () => expressFileSeen, () => expressPatchApplied],
        ['open-api.js', () => openApiFileSeen, () => openApiPatchApplied],
        ['download.js', () => downloadFileSeen, () => downloadPatchApplied],
        ['processors/index.js', () => processorsFileSeen, () => processorsPatchApplied],
        ['core/app.js', () => openApiDebugFileSeen, () => openApiDebugPatchApplied],
        ['utils/rs.js', () => rsFileSeen, () => rsPatchApplied],
    ];

    const dangerousRequireNames = [
        'dotenv',
        'fs',
        'path',
        'undici',
        'fetch-socks',
        'express',
        'body-parser',
        'cron',
        'child_process',
        'connect-history-api-fallback',
        'http-proxy-middleware',
        'mime-types',
        'ms',
        'nanoid',
        '@maxmind/geoip2-node',
        'stream/promises',
    ];
    // 模块名 -> 替换表达式。同一份表同时用于替换 eval(`require("x")`) 与裸 require('x') 两种写法。
    const requireShimEntries = [
        ['dotenv', '({ config: () => {} })'],
        ['fs', 'globalThis.__fs_shim__'],
        ['path', 'globalThis.__path_shim__'],
        ['undici', '({ request: globalThis.fetch, Agent: class {}, ProxyAgent: class {}, EnvHttpProxyAgent: class {} })'],
        ['fetch-socks', '({ socksDispatcher: () => null })'],
        ['express', 'null'],
        ['body-parser', '({ json: () => (req, res, next) => next(), urlencoded: () => (req, res, next) => next(), raw: () => (req, res, next) => next() })'],
        ['cron', '({ CronJob: class { constructor() {} } })'],
        ['child_process', '({ execFile: () => {} })'],
        ['connect-history-api-fallback', '(() => (req, res, next) => next())'],
        ['http-proxy-middleware', '({ createProxyMiddleware: () => (req, res, next) => next() })'],
        ['mime-types', '({ contentType: () => "text/plain" })'],
        ['ms', 'globalThis.__ms_shim__'],
        ['nanoid', '({ nanoid: (size = 21) => crypto.randomUUID().replace(/-/g, "").slice(0, size) })'],
        ['@maxmind/geoip2-node', '({ Reader: { openBuffer: () => ({ country: () => null, asn: () => null }) } })'],
        ['stream/promises', 'globalThis.__stream_promises_shim__'],
        // Sub-Store 2.42.x 起新增 src/runtime/*.js，用裸 require 懒加载 Node 内置模块。
        // Workers 下 isNode 恒为 false（ENV().isNode），tryNodeBuiltin 不会真正执行 load()，
        // 因此这里只需消除残留的 require，避免 Rollup/Workers 打包与运行时报错。
        ['dgram', '({ createSocket: () => ({}) })'],
        ['net', '({ Socket: class {}, createConnection: () => ({}) })'],
        ['tls', '({ connect: () => ({}) })'],
        ['node:worker_threads', '({ Worker: class {}, isMainThread: true })'],
    ];

    const dangerousRequirePatterns = dangerousRequireNames.flatMap((name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/');
        return [
            new RegExp(`eval\\s*\\(\\s*['\"\`]require\\s*\\(\\s*['\"\`]${escaped}['\"\`]\\s*\\)['\"\`]\\s*,?\\s*\\)`),
            new RegExp(`(?<!['\"\`])\\brequire\\s*\\(\\s*['\"\`]${escaped}['\"\`]\\s*\\)`),
        ];
    });
    function escapeModuleName(moduleName) {
        return moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/');
    }
    function replaceEvalRequire(contents, moduleName, replacement) {
        const escaped = escapeModuleName(moduleName);
        return contents.replace(
            new RegExp(`eval\\s*\\(\\s*['\"\`]require\\s*\\(\\s*['\"\`]${escaped}['\"\`]\\s*\\)['\"\`]\\s*,?\\s*\\)`, 'g'),
            replacement,
        );
    }
    function replaceBareRequire(contents, moduleName, replacement) {
        const escaped = escapeModuleName(moduleName);
        // 负向后顾确保只处理“裸” require，不会误伤字符串/模板里的 require 文本
        return contents.replace(
            new RegExp(`(?<!['\"\`])\\brequire\\s*\\(\\s*['\"\`]${escaped}['\"\`]\\s*\\)`, 'g'),
            replacement,
        );
    }

    function assertNoDangerousRequireResidue(contents, id, pluginContext) {
        const matched = dangerousRequirePatterns.find((pattern) => pattern.test(contents));
        if (matched) {
            pluginContext.error(`[sub-store-transform] ${id} 仍包含未替换的危险 require/eval: ${matched}`);
        }
    }

    function precompilePeggyParser(contents, id, pluginContext) {
        const match = /const\s+grammars\s*=\s*String\.raw`([\s\S]*?)`;/.exec(contents);
        if (!match) {
            pluginContext.error(`[sub-store-transform] ${id} Peggy parser 预编译失败：未找到 grammars`);
        }

        const parserSource = peggy.generate(match[1], {
            output: 'source',
            format: 'bare',
        });

        const output = `// __SUB_STORE_WORKERS_PATCH__PEGGY_PRECOMPILED_PARSER__
const parser = ${parserSource};

export default function getParser() {
    return parser;
}
`;
        if (output.includes('peggy.generate')) {
            pluginContext.error(`[sub-store-transform] ${id} Peggy parser 预编译失败：仍包含 peggy.generate`);
        }
        return output;
    }

    return {
        name: 'sub-store-transform',
        enforce: 'pre',
        transform(code, id) {
            if (!id.includes('sub-store/backend/src')) {
                return null;
            }
            subStoreFileSeen = true;

            let contents = code;

            for (const [moduleName, replacement] of requireShimEntries) {
                contents = replaceEvalRequire(contents, moduleName, replacement);
            }
            // 裸 require('x') 形式（上游 runtime/*.js 懒加载 Node 内置模块）
            for (const [moduleName, replacement] of requireShimEntries) {
                contents = replaceBareRequire(contents, moduleName, replacement);
            }

            contents = contents.replace(/const\s+isNode\s*=\s*eval\s*\(\s*`typeof\s+process\s*!==\s*"undefined"`\s*\)/g, 'const isNode = false');
            // 上游 2.42.x 起该行追加了 `&& !isEgern`，用 [^;]* 容忍后续新增条件
            contents = contents.replace(/const\s+isSurge\s*=\s*typeof\s+\$httpClient\s*!==\s*['"]undefined['"][^;]*;/g, 'const isSurge = true;');

            assertNoDangerousRequireResidue(contents, id, this);

            if (id.includes('utils/cors.js')) {
                contents = contents.replace(
                    /NON_NODE_CORS_DEFAULT\s*=\s*['"].+['"]/,
                    "NON_NODE_CORS_DEFAULT='*'",
                );
                if (contents.includes("https://sub-store.vercel.app")) {
                    this.error('[sub-store-transform] cors.js CORS 默认值替换未生效');
                }
            }

            // 仅处理“带 peggy 语法源”的解析器；上游新增的 trojan-uri.js 已是预编译产物（无 grammars），直接放行
            if (
                id.includes('sub-store/backend/src/core/proxy-utils/parsers/peggy/') &&
                /const\s+grammars\s*=\s*String\.raw`/.test(contents)
            ) {
                contents = precompilePeggyParser(contents, id, this);
            }

            if (id.includes('vendor/express.js')) {
                expressFileSeen = true;
                const before = contents;
                if (!contents.includes('__SUB_STORE_WORKERS_PATCH__REQUEST_DONE_DISPATCH__')) {
                    contents = contents.replace(
                        'const handlers = [];',
                        `// __SUB_STORE_WORKERS_PATCH__REQUEST_DONE_DISPATCH__
const handlers = [];

function __emitDone__(requestId, response) {
    const activeContext = globalThis.__substore_get_active_context__?.();
    if (activeContext && (!requestId || activeContext.requestId === requestId) && typeof activeContext.done === 'function') {
        activeContext.done(response);
        return;
    }
    const context = requestId ? globalThis.__substore_get_context_by_id__?.(requestId) : null;
    if (context && typeof context.done === 'function') {
        context.done(response);
        return;
    }
    const fallbackDone = globalThis.$done;
    if (typeof fallbackDone === 'function') {
        fallbackDone(response);
    }
}`,
                    );
                    contents = contents.replace(
                        'const req = {',
                        `const req = {
                __requestId: request.__requestId,`,
                    );
                    contents = contents.replace(
                        'const res = Response();',
                        'const res = Response({}, request.__requestId);',
                    );
                    contents = contents.replaceAll(
                        'const res = Response(cors.headers);',
                        'const res = Response(cors.headers, request.__requestId);',
                    );
                    contents = contents.replace(
                        /dispatch\s*\(\s*method\s*,\s*url\s*,\s*i\s*\)\s*;/g,
                        'dispatch(request, i + 1);',
                    );
                    contents = contents.replace(
                        'function Response(corsHeaders = {}) {',
                        'function Response(corsHeaders = {}, requestId) {',
                    );
                    contents = contents.replace(
                        '$done(response);',
                        '__emitDone__(requestId, response);',
                    );
                    contents = contents.replace(
                        `$done({
                        response,
                    });`,
                        `__emitDone__(requestId, {
                        response,
                    });`,
                    );
                }
                contents = contents.replace(
                    /app\.start\s*=\s*\(\)\s*=>\s*\{\s*dispatch\s*\(\s*\$request\s*\)\s*;\s*\}/g,
                    `app.start = () => {
                        // __SUB_STORE_WORKERS_PATCH__DISPATCH_EXPORT__
                        globalThis.__substore_dispatch__ = dispatch;
                    }`,
                );
                if (contents !== before) {
                    expressPatchApplied += 1;
                    if (!contents.includes('__SUB_STORE_WORKERS_PATCH__DISPATCH_EXPORT__')) {
                        this.error('[sub-store-transform] express.js 补丁自检失败：缺少 marker');
                    }
                    if (!contents.includes('__SUB_STORE_WORKERS_PATCH__REQUEST_DONE_DISPATCH__')) {
                        this.error('[sub-store-transform] express.js 请求级 done 补丁自检失败：缺少 marker');
                    }
                    if (!contents.includes('dispatch(request, i + 1);')) {
                        this.error('[sub-store-transform] express.js next() 补丁自检失败：仍可能把 method/url 当作 request 重新分发');
                    }
                    if (!contents.includes('function Response(corsHeaders = {}, requestId) {')) {
                        this.error('[sub-store-transform] express.js Response 补丁自检失败：requestId 未绑定到 Response');
                    }
                    if (!contents.includes('Response(cors.headers, request.__requestId)')) {
                        this.error('[sub-store-transform] express.js Response 补丁自检失败：cors 响应未绑定 requestId');
                    }
                } else {
                    this.error('[sub-store-transform] express.js 补丁未应用：未命中 app.start/dispatch($request) 片段');
                }
            }

            if (id.includes('vendor/open-api.js')) {
                openApiFileSeen = true;
                const beforeOpenApi = contents;

                const needsIsNodePatch = beforeOpenApi.includes('const isNode = eval(`typeof process');
                if (needsIsNodePatch && !contents.includes('const isNode = false')) {
                    this.error('[sub-store-transform] open-api.js 环境检测补丁未生效：isNode 仍可能触发 eval()');
                }
                const needsIsSurgePatch = beforeOpenApi.includes('const isSurge = typeof $httpClient');
                if (needsIsSurgePatch && !contents.includes('const isSurge = true;')) {
                    this.error('[sub-store-transform] open-api.js 环境检测补丁未生效：isSurge 未被固定为 true');
                }

                if (contents.includes('export class OpenAPI')) {
                    contents = contents.replace(
                        'export class OpenAPI',
                        `// 获取当前请求的缓存（请求级隔离）
// __SUB_STORE_WORKERS_PATCH__REQUEST_CACHE_ISOLATION__
function __getRequestCache__() {
    const context = globalThis.__substore_get_active_context__?.();
    if (!context) return {};
    if (!context.cache) context.cache = {};
    return context.cache;
}

function __setRequestCache__(key, value) {
    const context = globalThis.__substore_get_active_context__?.();
    if (!context) return;
    const cache = context.cache || (context.cache = {});
    cache[key] = value;
}

export class OpenAPI`,
                    );
                } else {
                    this.error('[sub-store-transform] open-api.js 补丁未应用：未找到 export class OpenAPI');
                }

                contents = contents.replace(/this\.cache\s*=\s*JSON\.parse\s*\(\s*\$persistentStore\.read\s*\(\s*this\.name\s*\)\s*\|\|\s*'{}'\s*\)/g, 'this.cache = __getRequestCache__()');
                contents = contents.replace(/const\s+data\s*=\s*JSON\.stringify\s*\(\s*this\.cache\s*,\s*null\s*,\s*2\s*\)/g, 'const data = JSON.stringify(__getRequestCache__(), null, 2)');
                contents = contents.replace(/this\.cache\[key\]\s*=\s*data;/g, '__setRequestCache__(key, data);');
                contents = contents.replace(/return\s+this\.cache\[key\];/g, 'return __getRequestCache__()[key];');
                contents = contents.replace(/delete\s+this\.cache\[key\];/g, 'const __cache__ = __getRequestCache__(); delete __cache__[key];');

                if (contents !== beforeOpenApi) openApiPatchApplied += 1;

                const requiredMarkers = [
                    '__SUB_STORE_WORKERS_PATCH__REQUEST_CACHE_ISOLATION__',
                    'this.cache = __getRequestCache__()',
                    'const data = JSON.stringify(__getRequestCache__(), null, 2)',
                    '__setRequestCache__(key, data);',
                    'return __getRequestCache__()[key];',
                    'const __cache__ = __getRequestCache__(); delete __cache__[key];',
                ];
                const missing = requiredMarkers.filter((m) => !contents.includes(m));
                if (missing.length > 0) {
                    this.error(`[sub-store-transform] open-api.js 补丁自检失败：缺少片段: ${missing.join(', ')}`);
                }
            }

            if (id.includes('sub-store/backend/src/utils/download.js')) {
                downloadFileSeen = true;
                if (!contents.includes('__SUB_STORE_WORKERS_PATCH__INFLIGHT_TASKS__')) {
                    const startMarker = 'export default async function download';
                    const endMarker = 'export async function downloadFile';
                    if (!contents.includes('const tasks = new Map();')) {
                        this.error('[sub-store-transform] download.js 结构已变化，补丁未应用：缺少 tasks 定义');
                    }
                    contents = contents.replace('const tasks = new Map();', `// __SUB_STORE_WORKERS_PATCH__INFLIGHT_TASKS__
const tasks = {
    has: () => false,
    get: () => undefined,
    set: () => {},
    delete: () => {},
};`);
                    const startIdx = contents.indexOf(startMarker);
                    const endIdx = contents.indexOf(endMarker);
                    if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
                        this.error(`[sub-store-transform] 无法定位 download() 的边界，补丁未应用：${id}`);
                    }
                    const before = contents.slice(0, startIdx);
                    const chunk = contents.slice(startIdx, endIdx);
                    const after = contents.slice(endIdx);
                    const requiredNeedles = ['tasks.has(id)', 'tasks.set(id, rawResult)', 'const id = hex_md5('];
                    const missing = requiredNeedles.filter((n) => !chunk.includes(n));
                    if (missing.length > 0) {
                        this.error(`[sub-store-transform] download.js 结构已变化，补丁未应用：缺少关键片段: ${missing.join(', ')}`);
                    }
                    let patchedChunk = chunk.replace(startMarker, 'async function __download_impl__');
                    const wrapper = `export default async function download(
    rawUrl = '',
    ua,
    timeout,
    customProxy,
    skipCustomCache,
    awaitCustomCache,
    noCache,
    preprocess,
) {
    let $arguments = {};
    try {
        let url = String(rawUrl).replace(/#noFlow$/, '');
        const rawArgs = url.split('#');
        url = url.split('#')[0];
        if (rawArgs.length > 1) {
            try {
                $arguments = JSON.parse(decodeURIComponent(rawArgs[1]));
            } catch (e) {
                for (const pair of rawArgs[1].split('&')) {
                    const key = pair.split('=')[0];
                    const value = pair.split('=')[1];
                    $arguments[key] = value == null || value === '' ? true : decodeURIComponent(value);
                }
            }
        }
    } catch (e) {
        $arguments = {};
    }

    if (noCache || ($arguments && $arguments.noCache)) {
        return await __download_impl__(rawUrl, ua, timeout, customProxy, skipCustomCache, awaitCustomCache, noCache, preprocess);
    }

    const context = globalThis.__substore_get_active_context__?.();
    const scope = context?.user?.id ?? context?.requestId ?? '';
    const inflightKey = String(scope) + '::' + String(ua || '') + '::' + String(rawUrl) + '::' + (preprocess ? '1' : '0');
    if (!globalThis.__sub_store_workers_inflight_tasks__) {
        globalThis.__sub_store_workers_inflight_tasks__ = new Map();
    }
    if (globalThis.__sub_store_workers_inflight_tasks__.has(inflightKey)) {
        return await globalThis.__sub_store_workers_inflight_tasks__.get(inflightKey);
    }
    const p = (async () => {
        try {
            return await __download_impl__(rawUrl, ua, timeout, customProxy, skipCustomCache, awaitCustomCache, noCache, preprocess);
        } finally {
            globalThis.__sub_store_workers_inflight_tasks__.delete(inflightKey);
        }
    })();
    globalThis.__sub_store_workers_inflight_tasks__.set(inflightKey, p);
    return await p;
}
`;
                    patchedChunk = wrapper + '\n' + patchedChunk;
                    if (!patchedChunk.includes('export default async function download(')) {
                        this.error('[sub-store-transform] download.js 补丁自检失败：wrapper 未注入');
                    }
                    downloadPatchApplied += 1;
                    contents = before + patchedChunk + after;
                    if (!contents.includes('__SUB_STORE_WORKERS_PATCH__INFLIGHT_TASKS__')) {
                        this.error('[sub-store-transform] download.js 补丁自检失败：缺少 marker');
                    }
                }
            }

            if (id.includes('sub-store/backend/src/core/proxy-utils/processors/index.js')) {
                processorsFileSeen = true;
                if (!contents.includes('__SUB_STORE_WORKERS_PATCH__QUICKJS_CREATE_DYNAMIC_FUNCTION__')) {
                    const startMarker = 'function createDynamicFunction(name, script, $arguments, $options) {';
                    const startIdx = contents.indexOf(startMarker);
                    if (startIdx === -1) {
                        this.error('[sub-store-transform] processors/index.js 补丁未应用：未找到 createDynamicFunction 定义');
                    }
                    const before = contents.slice(0, startIdx);
                    const patched = `function createDynamicFunction(name, script, $arguments, $options) {
    // __SUB_STORE_WORKERS_PATCH__QUICKJS_CREATE_DYNAMIC_FUNCTION__
    const flowUtils = {
        getFlowField,
        getFlowHeaders,
        parseFlowHeaders,
        flowTransfer,
        validCheck,
        getRmainingDays,
        normalizeFlowHeader,
    };

    const factory = globalThis.__substore_workers_createDynamicFunction__;
    if (typeof factory !== 'function') {
        throw new Error('[Sub-Store Workers] QuickJS script engine not installed');
    }

    return factory({
        name,
        script,
        $arguments,
        $options,
        $substore: $,
        lodash,
        ProxyUtils,
        DOMAIN_RESOLVERS,
        scriptResourceCache,
        flowUtils,
        produceArtifact,
    });
}
`;
                    processorsPatchApplied += 1;
                    contents = before + patched;
                    if (!contents.includes('__SUB_STORE_WORKERS_PATCH__QUICKJS_CREATE_DYNAMIC_FUNCTION__')) {
                        this.error('[sub-store-transform] processors/index.js 补丁自检失败：缺少 marker');
                    }
                }
            }

            if (id.includes('sub-store/backend/src/core/app.js')) {
                openApiDebugFileSeen = true;
                if (!contents.includes('__SUB_STORE_WORKERS_PATCH__OPENAPI_DEBUG__')) {
                    const beforeApp = contents;
                    contents = contents.replace(
                        "const $ = new OpenAPI('sub-store');",
                        "const $ = new OpenAPI('sub-store', (process.env.DEBUG === 'true' || process.env.DEBUG === true)); /* __SUB_STORE_WORKERS_PATCH__OPENAPI_DEBUG__ */",
                    );
                    if (contents !== beforeApp) {
                        openApiDebugPatchApplied += 1;
                    } else {
                        this.error('[sub-store-transform] core/app.js debug 补丁未应用：未命中 OpenAPI 初始化行');
                    }
                }
            }

            if (id.includes('sub-store/backend/src/utils/rs.js')) {
                rsFileSeen = true;
                contents = `import { createHash } from 'node:crypto';

function pemToDerBuffer(caStr) {
    const pem = String(caStr || '');
    const base64 = pem
        .replace(/-----BEGIN[^-]+-----/g, '')
        .replace(/-----END[^-]+-----/g, '')
        .replace(/\s+/g, '');
    return Buffer.from(base64, 'base64');
}

export function generateFingerprint(caStr) {
    const derBuffer = pemToDerBuffer(caStr);
    const fingerprint = createHash('sha256').update(derBuffer).digest('hex');
    return fingerprint.match(/.{2}/g).join(':').toUpperCase();
}

export default {
    generateFingerprint,
};
`;
                rsPatchApplied += 1;
                if (contents.includes('jsrsasign')) {
                    this.error('[sub-store-transform] utils/rs.js 补丁自检失败：仍包含 jsrsasign');
                }
                if (!contents.includes("from 'node:crypto'")) {
                    this.error('[sub-store-transform] utils/rs.js 补丁自检失败：未使用 node:crypto');
                }
            }

            if (contents !== code) {
                return { code: contents, map: null };
            }
            return null;
        },

        buildEnd() {
            if (!subStoreFileSeen) return;
            for (const [name, seen] of requiredTargetFiles) {
                if (!seen()) this.error(`[sub-store-transform] 必需补丁目标未进入构建图：${name}`);
            }
            for (const [name, _seen, applied] of requiredTargetFiles) {
                const count = applied();
                if (count !== 1) this.error(`[sub-store-transform] ${name} 补丁未正确应用：期望 1 次，实际 ${count} 次`);
            }
        },
    };
}