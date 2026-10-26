const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { parseTicketCatalogue, createCatalogueLoader } = require('../ticket-catalogue');

function example() {
  return { staff: [{ id: 'simon', name: 'Simon', aliases: ['Simon L'] }], microscopes: [
    { id: 'lsm_880', name: 'LSM 880' }, { id: 'lsm_980', name: 'LSM 980', aliases: ['LSM980'] },
  ] };
}

test('catalogue accepts explicit names/aliases, case and spacing but never fuzzy matches', () => {
  const catalogue = parseTicketCatalogue(YAML.stringify(example()));
  assert.equal(catalogue.resolve('staff', ' SIMON '), 'simon');
  assert.equal(catalogue.resolve('staff', 'simon l'), 'simon');
  assert.equal(catalogue.resolve('microscopes', ' lSm   980 '), 'lsm_980');
  assert.equal(catalogue.resolve('microscopes', 'LSM980'), 'lsm_980');
  assert.equal(catalogue.resolve('microscopes', 'LSM 880'), 'lsm_880');
  for (const value of ['LSM 990', 'LSM 98', 'LSM 9800', ['LSM 980'], 980]) {
    assert.throws(() => catalogue.resolve('microscopes', value), { status: 400 });
  }
  assert.throws(() => catalogue.resolve('staff', 'sion'), { status: 400 });
  assert.throws(() => catalogue.resolve('staff', ''), { status: 400 });
  assert.equal(catalogue.resolve('staff', '', { optional: true }), null);
  assert.equal(catalogue.resolve('microscopes', null, { optional: true }), null);
});

test('invalid or ambiguous administrator configuration is rejected', () => {
  for (const alter of [
    (value) => { value.staff = []; },
    (value) => { delete value.microscopes; },
    (value) => { value.staff.push({ id: 'simon', name: 'Another person' }); },
    (value) => { value.staff.push({ id: 'other', name: 'SIMON' }); },
    (value) => { value.staff.push({ id: 'other', name: 'Other', aliases: ['simon'] }); },
    (value) => { value.staff[0].id = '../simon'; },
    (value) => { value.staff[0].name = ' '; },
    (value) => { value.microscopes[0].aliases = 'invalid'; },
    (value) => { value.staff[0].extra = true; },
  ]) {
    const value = example(); alter(value);
    assert.throws(() => parseTicketCatalogue(YAML.stringify(value)));
  }
  assert.throws(() => parseTicketCatalogue('staff: []\nstaff: []\nmicroscopes: []'));
  assert.throws(() => parseTicketCatalogue('staff: &a [{id: simon, name: Simon}]\nmicroscopes: *a'));
});

test('mounted-file loader caches a catalogue until a new loader/restart and fails clearly without a mount', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ticket-catalogue-'));
  const filename = path.join(directory, 'catalogue.yaml');
  try {
    const value = example(); writeFileSync(filename, YAML.stringify(value));
    const load = createCatalogueLoader();
    const original = load(filename);
    value.staff[0].name = 'Simon renamed'; writeFileSync(filename, YAML.stringify(value));
    assert.equal(load(filename), original);
    const afterRestart = createCatalogueLoader()(filename);
    assert.equal(afterRestart.staff[0].name, 'Simon renamed');
    assert.equal(afterRestart.resolve('staff', 'simon'), 'simon');
    assert.throws(() => load(path.join(directory, 'missing.yaml')), { status: 503, code: 'TICKET_CATALOGUE_CONFIG' });
    writeFileSync(filename, 'staff: [invalid]');
    assert.throws(() => createCatalogueLoader()(filename), { status: 503 });
  } finally { unlinkSync(filename); rmdirSync(directory); }
});

test('repository ConfigMap and deployment patch agree with the application mount', () => {
  const root = path.join(__dirname, '../..');
  const configMap = YAML.parse(readFileSync(path.join(root, 'ticket-catalogue.configmap.yaml'), 'utf8'));
  const catalogue = parseTicketCatalogue(configMap.data['catalogue.yaml']);
  assert.ok(catalogue.staff.some((entry) => entry.id === 'simon' && entry.name === 'Simon'));
  assert.equal(catalogue.resolve('microscopes', 'LSM 880'), 'lsm_880');
  assert.equal(catalogue.resolve('microscopes', 'LSM 980'), 'lsm_980');
  const patch = YAML.parse(readFileSync(path.join(root, 'ticket-catalogue.deployment-patch.yaml'), 'utf8'));
  assert.equal(patch.spec.template.spec.volumes[0].configMap.name, configMap.metadata.name);
  const container = patch.spec.template.spec.containers[0];
  assert.equal(container.name, 'dashboard-test');
  assert.equal(container.volumeMounts[0].mountPath, '/etc/dashboard/ticket-catalogue');
  assert.equal(container.volumeMounts[0].readOnly, true);
});
