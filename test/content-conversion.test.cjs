const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8').replace(/\r/g, '');
const sendCode = source.slice(source.indexOf('async function send('), source.indexOf('async function resolveFile('));

test('shared MIME lookup supplies inferred types and retains explicit HTTP parameters', async () => {
    const { getContentType } = await import('@cocreate/utils/file');
    for (const [pathname, src, explicit, expectedHeader, expectedType] of [
        ['/styles.css', 'body {}', undefined, 'text/css', 'text/css'],
        ['/image.PNG', Buffer.from([0, 255]), undefined, 'image/png', 'image/png'],
        ['/unknown', '<html></html>', undefined, 'text/html', 'text/html'],
        ['/unknown', 'data:image/svg+xml;base64,PHN2Zy8+', undefined, 'image/svg+xml', 'image/svg+xml'],
        ['/index.html', '<html></html>', 'text/html; charset=utf-8', 'text/html; charset=utf-8', 'text/html'],
        ['/image.png', Buffer.from([0, 255]), 'IMAGE/PNG', 'IMAGE/PNG', 'image/png'],
        ['/wrong.css', '<html></html>', 'text/html', 'text/html', 'text/html']
    ]) {
        let normalized;
        let sent;
        const send = vm.runInNewContext(`(() => { ${sendCode}; return send; })()`, {
            URL, getContentType,
            console: { error(...args) { throw new Error(args.join(' ')); } },
            server: { crud: { getOrganization: async () => ({ _id: 'test' }) } },
            fileServerConfig: { enableThemeDetection: false, enableSitemapCheck: false },
            createRequestSession: async () => ({ policies: [] }),
            handleTrailingSlash: () => false,
            resolveFile: async () => ({ file: { src, 'content-type': explicit }, src, statusCode: 200, resolvedPathname: pathname }),
            parseLanguage: () => ({}),
            normalizeSrc: async args => { normalized = args; return args.src; },
            sendResponse: args => { sent = args; }
        });
        await send({ url: pathname, headers: { host: 'example.test' } }, { setHeader() {} });
        assert.equal(normalized.contentType, expectedType, pathname);
        assert.equal(sent.headers['Content-Type'], expectedHeader, pathname);
        assert.equal(sent.src, src);
        assert.equal(sent.statusCode, 200);
    }
});
