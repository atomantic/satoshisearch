import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Exercise the cookie implementation SvelteKit actually resolves, including if
// npm later nests it under Kit instead of hoisting it to the application root.
const { parse, serialize } = createRequire(import.meta.resolve('@sveltejs/kit'))('cookie');

test('cookie serialization rejects attribute injection (GHSA-pxg6-pf52-xh8x)', () => {
  assert.throws(() => serialize('session=x; admin', 'value'), /name is invalid/);
  assert.throws(() => serialize('session', 'value', { path: '/; SameSite=None' }), /path is invalid/);
  assert.throws(
    () => serialize('session', 'value', { domain: 'example.test; Secure' }),
    /domain is invalid/
  );
});

test('cookie override preserves encoding and SvelteKit cookie options', () => {
  const value = 'value with spaces;=';
  const header = serialize('session', value, {
    domain: '.example.test',
    path: '/settings',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 3600
  });
  assert.equal(
    header,
    'session=value%20with%20spaces%3B%3D; Max-Age=3600; Domain=.example.test; Path=/settings; HttpOnly; Secure; SameSite=Lax'
  );
  assert.deepEqual(parse(header.split(';')[0]), { session: value });
  assert.equal(
    serialize('session', '', { path: '/', maxAge: 0 }),
    'session=; Max-Age=0; Path=/'
  );
});

test('cookie override preserves request parsing and custom decoding', () => {
  assert.deepEqual(parse('session=first; session=second; encoded=hello%20world'), {
    session: 'first',
    encoded: 'hello world'
  });
  assert.deepEqual(parse('encoded=hello%20world', { decode: (value: string) => value }), {
    encoded: 'hello%20world'
  });
});
