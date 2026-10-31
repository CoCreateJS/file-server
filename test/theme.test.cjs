const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8').replace(/\r/g, '');
const detection = source.slice(source.indexOf('function detectTheme('), source.indexOf('function handleTrailingSlash('));
const normalization = source.slice(source.indexOf('async function normalizeSrc('), source.indexOf('async function sendResponse('));

test('browser color-scheme hints take priority and invalid hints allow a fallback', () => {
    const detectTheme = vm.runInNewContext(`${detection}\ndetectTheme`);
    for (const [headers, expected] of [
        [{ 'sec-ch-prefers-color-scheme': 'dark' }, 'dark'],
        [{ 'sec-ch-prefers-color-scheme': '"light"' }, 'light'],
        [{ 'sec-ch-prefers-color-scheme': 'dark', 'x-prefers-color-scheme': 'light' }, 'dark'],
        [{ 'sec-ch-prefers-color-scheme': 'invalid', 'x-prefers-color-scheme': 'light' }, 'light'],
        [{ 'x-prefers-color-scheme': 'dark' }, 'dark'],
        [{ 'sec-ch-prefers-color-scheme': 'invalid' }, undefined],
        [{}, undefined]
    ]) {
        const responseHeaders = {};
        assert.equal(detectTheme({ headers }, {
            setHeader(name, value) { responseHeaders[name] = value; }
        }), expected);
        assert.equal(responseHeaders['X-Preferred-Color-Scheme'], expected);
    }
});

test('file-server forwards the browser hint through SSR to the attribute and metadata', async () => {
    const render = await import('@cocreate/server-side-render');
    const api = vm.runInNewContext(`${detection}\n${normalization}\n({detectTheme, normalizeSrc})`, {
        Buffer, server: null, render
    });
    for (const [hint, saved, expected] of [
        ['dark', '', 'dark'],
        ['light', '', 'light'],
        ['dark', 'light', 'light']
    ]) {
        const theme = api.detectTheme({ headers: { 'sec-ch-prefers-color-scheme': hint } });
        const file = {
            src: '<html state-id="theme" color-scheme=""><head></head><body>Admin</body></html>',
            pathname: '/admin/index.html'
        };
        const result = await api.normalizeSrc({
            src: file.src, contentType: 'text/html', pathname: file.pathname,
            file, organization: { _id: 'test' }, urlObject: new URL('https://example.test/admin/'),
            theme, state: JSON.stringify({ theme: { 'color-scheme': saved } })
        });
        assert.match(result, new RegExp(`color-scheme="${expected}"`));
        assert.match(result, new RegExp(`<meta name="color-scheme" content="${expected}">`));
    }
});
