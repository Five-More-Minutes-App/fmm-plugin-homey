import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { TRIGGERS } = require('../lib/controller.js');

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = (path) => JSON.parse(read(path));

const manifest = json('app.json');
const en = json('locales/en.json');
const sv = json('locales/sv.json');

const leaves = (node, prefix = '') => Object.entries(node).flatMap(([k, v]) => (typeof v === 'object' ? leaves(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
const lookup = (table, key) => key.split('.').reduce((n, p) => n?.[p], table);
const holes = (text) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

/** Everything with a title, description or hint that a person reads, wherever it is in the manifest. */
function texts(node, path = '') {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    if ('en' in node && typeof node.en === 'string') return [[path, node]];
    return Object.entries(node).flatMap(([k, v]) => texts(v, `${path}/${k}`));
  }
  if (Array.isArray(node)) return node.flatMap((v, i) => texts(v, `${path}[${i}]`));
  return [];
}

describe('the manifest', () => {
  it('is up to date with what is in .homeycompose (run `homey app build` after changing it)', () => {
    // The composed app.json is committed, as Homey apps do. It must list every card and capability.
    for (const id of Object.values(TRIGGERS)) assert.ok(manifest.flow.triggers.some((t) => t.id === id), `trigger ${id}`);
    for (const id of ['fmm_online', 'fmm_timer_running', 'fmm_minutes_left', 'fmm_locked']) assert.ok(manifest.capabilities[id], `capability ${id}`);
    assert.equal(manifest.drivers.length, 1);
    assert.deepEqual(manifest.drivers[0].capabilities.sort(), ['fmm_locked', 'fmm_minutes_left', 'fmm_online', 'fmm_timer_running']);
  });

  it('asks for no permissions, because it uses none of Homey\'s', () => {
    assert.deepEqual(manifest.permissions, []);
  });

  it('is for Homey Pro only, because the service answers the local network only', () => {
    assert.deepEqual(manifest.platforms, ['local']);
    assert.deepEqual(manifest.drivers[0].platforms, ['local']);
    assert.deepEqual(manifest.drivers[0].connectivity, ['lan']);
  });

  it('gives every flow card, capability and text a title in English and Swedish', () => {
    const found = texts({ flow: manifest.flow, capabilities: manifest.capabilities, name: manifest.name, description: manifest.description, driver: manifest.drivers[0].name });
    assert.ok(found.length > 40);
    for (const [path, text] of found) {
      assert.ok(text.en?.trim(), `${path} has English`);
      assert.ok(text.sv?.trim(), `${path} has Swedish`);
    }
  });

  it('gives condition and action titles the same placeholders in both languages', () => {
    for (const card of [...manifest.flow.actions, ...manifest.flow.conditions]) {
      const tokens = (t) => [...(t?.matchAll(/\[\[(\w+)\]\]/g) ?? [])].map((m) => m[1]).sort();
      if (card.titleFormatted) assert.deepEqual(tokens(card.titleFormatted.sv), tokens(card.titleFormatted.en), card.id);
    }
  });

  it('refers, in titleFormatted, only to arguments that exist', () => {
    for (const card of manifest.flow.actions) {
      const names = new Set(card.args.map((a) => a.name));
      for (const [, name] of (card.titleFormatted?.en ?? '').matchAll(/\[\[(\w+)\]\]/g)) assert.ok(names.has(name), `${card.id}: ${name}`);
    }
  });

  it('has an app and a driver icon, and images at the sizes Homey wants', () => {
    for (const path of ['assets/icon.svg', 'drivers/computer/assets/icon.svg']) assert.match(read(path), /^<svg/);
    const size = (path) => { const b = readFileSync(new URL(`../${path}`, import.meta.url)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
    assert.deepEqual(size('assets/images/small.png'), [250, 175]);
    assert.deepEqual(size('assets/images/large.png'), [500, 350]);
    assert.deepEqual(size('assets/images/xlarge.png'), [1000, 700]);
    assert.deepEqual(size('drivers/computer/assets/images/small.png'), [75, 75]);
    assert.deepEqual(size('drivers/computer/assets/images/large.png'), [500, 500]);
    assert.deepEqual(size('drivers/computer/assets/images/xlarge.png'), [1000, 1000]);
  });
});

describe('the words', () => {
  it('exist in both languages, the same set of them', () => {
    assert.deepEqual(leaves(sv).sort(), leaves(en).sort());
  });

  it('keep the same placeholders in both languages', () => {
    for (const key of leaves(en)) assert.deepEqual(holes(lookup(sv, key)), holes(lookup(en, key)), key);
  });

  it('are all used, and every one used exists', () => {
    const source = ['lib/errors.js', 'lib/flow.js', 'lib/controller.js', 'drivers/computer/driver.js', 'drivers/computer/pair/connect.html', 'drivers/computer/repair/connect.html'].map(read).join('\n');
    const used = new Set([...source.matchAll(/['"]((?:errors|pair|repair)\.[A-Za-z.]+)['"]/g)].map((m) => m[1]));
    for (const key of ['errors.config', 'errors.auth', 'errors.networkOnly', 'errors.forbidden', 'errors.notPossible', 'errors.invalid', 'errors.rateLimited', 'errors.network', 'errors.unexpected']) used.add(key);

    for (const key of used) assert.ok(lookup(en, key) !== undefined, `${key} is used but missing`);
    for (const key of leaves(en)) assert.ok(used.has(key), `${key} is never used`);
  });
});

describe('the pairing views', () => {
  it('repair is pairing with its own title and ending', () => {
    const pair = read('drivers/computer/pair/connect.html');
    const repair = read('drivers/computer/repair/connect.html');

    assert.equal(repair, pair.replace('Homey.nextView();', 'Homey.done();').replace("'pair.connect.title'", "'repair.connect.title'").replace('"pair.connect.intro"', '"repair.connect.intro"'));
  });

  it('put nothing on the page as HTML, and forget the key once it is sent', () => {
    const view = read('drivers/computer/pair/connect.html');

    assert.doesNotMatch(view, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    assert.match(view, /getElementById\('fmm-key'\)\.value = ''/);
    assert.match(view, /type="password"/);
  });
});
