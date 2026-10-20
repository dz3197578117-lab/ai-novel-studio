import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSo360, parseSogou } from '../services/websearch.js';

const SO360_HTML = `
<ul class="result">
  <li class="res-list" data-result-type="richsum">
    <h3 class="res-title"><a href="https://baike.so.com/doc/283070-299700.html"><em>营造司</em>_360百科</a></h3>
    <div class="res-rich"><p class="res-desc"><span class="res-list-summary">营造司是清<em>内务府</em>所属机构，掌宫廷缮修及<em>薪炭</em>。</span></p></div>
  </li>
  <li class="res-list" data-result-type="normal">
    <h3 class="res-title"><a href="https://www.qinghistory.cn/c/393/393625.shtml">营造司 - 中华文史网</a></h3>
    <div class="res-rich"><p class="res-desc">掌修缮工程、薪库炭库。</p></div>
  </li>
</ul>`;

const SOGOU_HTML = `
<div class="results">
  <div class="vrwrap" id="sogou_vr_1">
    <h3 class="vr-title"><a href="/link?url=abc123" target="_blank">营造司_知网阅读</a></h3>
    <div class="fz-mid space-txt" id="cacheresult_summary_1">清朝置，为内务府七司之一，掌本府修缮及薪炭陶冶等。</div>
  </div>
  <div class="vrwrap" id="sogou_vr_2">
    <h3 class="vr-title"><a href="https://www.sogou.com/web?query=x" target="_blank">另一条</a></h3>
    <div class="fz-mid space-txt">摘要内容。</div>
  </div>
</div>`;

test('parseSo360 解析标题、链接与摘要', () => {
  const r = parseSo360(SO360_HTML, 5);
  assert.equal(r.length, 2);
  assert.equal(r[0]!.title, '营造司_360百科');
  assert.equal(r[0]!.url, 'https://baike.so.com/doc/283070-299700.html');
  assert.match(r[0]!.snippet, /薪炭/);
  assert.equal(r[0]!.engine, 'so360');
  assert.equal(r[1]!.url, 'https://www.qinghistory.cn/c/393/393625.shtml');
});

test('parseSo360 忽略相对链接', () => {
  const html = `<li class="res-list"><h3><a href="/relative">x</a></h3></li>`;
  assert.equal(parseSo360(html).length, 0);
});

test('parseSogou 把相对 /link 补成绝对地址', () => {
  const r = parseSogou(SOGOU_HTML, 5);
  assert.equal(r.length, 2);
  assert.equal(r[0]!.url, 'https://www.sogou.com/link?url=abc123');
  assert.match(r[0]!.snippet, /内务府七司/);
  assert.equal(r[0]!.engine, 'sogou');
});

test('parseSogou 对空 HTML 返回空数组', () => {
  assert.deepEqual(parseSogou(''), []);
});

test('解析器容忍 HTML 实体', () => {
  const html = `<li class="res-list"><h3><a href="https://a.com/x?a=1&amp;b=2">A &amp; B</a></h3><p class="res-desc">x &lt; y</p></li>`;
  const r = parseSo360(html)[0]!;
  assert.equal(r.title, 'A & B');
  assert.equal(r.url, 'https://a.com/x?a=1&b=2');
  assert.equal(r.snippet, 'x < y');
});
