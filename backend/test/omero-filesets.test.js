const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFilesetQuery } = require('../routes/omero');

test('fileset query defaults to active filesets ordered by size', () => {
  const query = buildFilesetQuery({});

  assert.equal(query.page, 1);
  assert.equal(query.pageSize, 50);
  assert.equal(query.where, 'WHERE deleted_at IS NULL');
  assert.equal(query.orderBy, 'total_bytes DESC NULLS LAST, fileset_id ASC');
  assert.deepEqual(query.values, []);
});

test('fileset query parameterizes search and filters', () => {
  const query = buildFilesetQuery({
    search: 'smith',
    group_id: '12',
    status: 'active',
    imported: '90d',
    size: '100gb',
    page: '2',
    pageSize: '25',
    sort: 'imported_at',
    order: 'asc',
  });

  assert.equal(query.page, 2);
  assert.equal(query.pageSize, 25);
  assert.equal(query.orderBy, 'imported_at ASC NULLS LAST, fileset_id ASC');
  assert.deepEqual(query.values, ['%smith%', '12', 90, 100_000_000_000]);
  assert.match(query.where, /group_id = \$2::bigint/);
  assert.match(query.where, /imported_at >= CURRENT_TIMESTAMP/);
  assert.match(query.where, /total_bytes > \$4::numeric/);
});

test('fileset query rejects invalid pagination and SQL ordering input', () => {
  assert.equal(buildFilesetQuery({ page: '0' }), null);
  assert.equal(buildFilesetQuery({ pageSize: '101' }), null);
  assert.equal(buildFilesetQuery({ sort: 'total_bytes; DROP TABLE omero_fileset' }), null);
  assert.equal(buildFilesetQuery({ order: 'desc; DROP TABLE omero_fileset' }), null);
  assert.equal(buildFilesetQuery({ group_id: '12 OR 1=1' }), null);
});
