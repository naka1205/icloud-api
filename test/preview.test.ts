import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizePreview,
  sanitizePlainPreview,
  stripHTML,
  normalizePreview,
} from '../src/mail/preview.js';

// Ported verbatim from internal/mail/preview_test.go.
test('sanitizePreview removes invisible HTML blocks', () => {
  const raw =
    '<html><head><style>@font-face { font-family: Söhne; } body { color: red; }</style></head><body><p>验证码：123456</p><script>alert(1)</script></body></html>';
  assert.equal(sanitizePreview(raw), '验证码：123456');
});

test('sanitizePreview drops CSS-only content', () => {
  const raw =
    '@font-face { font-family: Söhne; } .ExternalClass { line-height: 100%; } #bodyTable { width: 560px; } body { font-family: Helvetica, Arial, sans-serif; }';
  assert.equal(sanitizePreview(raw), '');
});

test('sanitizePreview removes CSS prefix and keeps body', () => {
  const raw =
    '@font-face { font-family: Söhne; } .ExternalClass { line-height: 100%; } 正文内容';
  assert.equal(sanitizePreview(raw), '正文内容');
});

test('sanitizePreview keeps normal text with ; and :', () => {
  const raw = '订单号：A-123; 请在 10:00 前完成验证。';
  assert.equal(sanitizePreview(raw), raw);
});

test('stripHTML: br, block ends, list items, entities', () => {
  assert.equal(stripHTML('<p>第一行</p><p>第二行</p>'), '第一行\n第二行');
  assert.equal(stripHTML('a<br>b'), 'a\nb');
  assert.equal(stripHTML('<ul><li>一</li><li>二</li></ul>'), '- 一\n- 二');
  assert.equal(stripHTML('a &amp; b &lt;tag&gt;'), 'a & b <tag>');
  assert.equal(stripHTML('<!-- 注释 -->可见'), '可见');
});

test('normalizePreview: collapses blank lines and trims', () => {
  assert.equal(normalizePreview('  a  \n\n\n\n  b \n'), 'a\n\nb');
});

test('sanitizePlainPreview: plain text passes through', () => {
  assert.equal(sanitizePlainPreview('hello world'), 'hello world');
  assert.equal(sanitizePlainPreview(''), '');
});
