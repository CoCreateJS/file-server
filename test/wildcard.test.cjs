const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {getCachePolicy} = require('../src/cachePolicy.js');
const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8').replace(/\r\n/g, '\n');
const resolveCode = source.slice(source.indexOf('async function resolveFile('), source.indexOf('\n/**\n * Specifically resolves'));
const wildcardCode = source.slice(source.indexOf('function getWildcardPath('), source.indexOf('\n/**\n * Detects color scheme'));
for (const found of [true, false]) {
    test(`missing exact file resolves ${found ? 'wildcard' : '404'} without throwing`, async () => {
        const queries = [];
        const wildcard = { _id: 'wildcard', src: 'wildcard content', headers: { 'cache-control': 'public' } };
        const notFound = { src: 'not found', headers: { 'cache-control': 'public' } };
        const crud = { send: async data => {
            queries.push(data.filter.query.pathname);
            return { object: queries.length === 2 && found ? [wildcard] : [] };
        } };
        const resolveFile = vm.runInNewContext(`${wildcardCode}\n${resolveCode}\nresolveFile`, {
            getCachePolicy,
            getDefaultFile: async () => ({ object: [notFound] })
        });
        const result = await resolveFile({ pathname: '/components/missing.html', hostname: 'example.test', organizationId: 'org', crud });
        assert.deepEqual(queries, ['/components/missing.html', '/components/*.html']);
        assert.equal(result.statusCode, found ? 200 : 404);
        assert.equal(result.src, found ? 'wildcard content' : 'not found');
    });
}
