const { readFileSync } = require('fs');
const YAML = require('yaml');

const DEFAULT_PATH = '/etc/dashboard/ticket-catalogue/catalogue.yaml';
const normalize = (value) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

function parseTicketCatalogue(source) {
  const document = YAML.parse(source, { maxAliasCount: 0, prettyErrors: false, uniqueKeys: true });
  if (!document || typeof document !== 'object' || Array.isArray(document)
      || Object.keys(document).some((key) => !['staff', 'microscopes'].includes(key))) {
    throw new Error('Expected staff and microscopes lists');
  }
  const lookups = {};
  const lists = {};
  for (const kind of ['staff', 'microscopes']) {
    const entries = document[kind];
    if (!Array.isArray(entries) || !entries.length || entries.length > 500) throw new Error(`Invalid ${kind} list`);
    const lookup = new Map();
    const ids = new Set();
    lists[kind] = entries.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
          || Object.keys(entry).some((key) => !['id', 'name', 'aliases'].includes(key))
          || typeof entry.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(entry.id)
          || entry.id === 'all' || ids.has(entry.id)
          || typeof entry.name !== 'string' || !entry.name.trim() || entry.name !== entry.name.trim()
          || entry.name.length > (kind === 'staff' ? 180 : 150)
          || /[\x00-\x1f\x7f]/.test(entry.name)) throw new Error(`Invalid or duplicate ${kind} entry`);
      ids.add(entry.id);
      const aliases = entry.aliases === undefined ? [] : entry.aliases;
      if (!Array.isArray(aliases) || aliases.length > 20 || aliases.some((alias) => typeof alias !== 'string'
          || !alias.trim() || alias.length > 180 || /[\x00-\x1f\x7f]/.test(alias))) throw new Error(`Invalid ${kind} aliases`);
      for (const value of [entry.id, entry.name, ...aliases]) {
        const key = normalize(value);
        if (lookup.has(key) && lookup.get(key) !== entry.id) throw new Error(`Ambiguous ${kind} name or alias`);
        lookup.set(key, entry.id);
      }
      return Object.freeze({ id: entry.id, name: entry.name });
    });
    lookups[kind] = lookup;
    Object.freeze(lists[kind]);
  }
  return Object.freeze({
    ...lists,
    resolve(kind, value, { optional = false, label = kind } = {}) {
      if (optional && (value === undefined || value === null || (typeof value === 'string' && !value.trim()))) return null;
      const result = typeof value === 'string' && value.length <= 200 ? lookups[kind]?.get(normalize(value)) : null;
      if (!result) {
        const error = new Error(`Choose a valid ${label} from the ticket catalogue`);
        error.status = 400;
        throw error;
      }
      return result;
    },
  });
}

function createCatalogueLoader() {
  let catalogue;
  let loadedPath;
  return (filename = process.env.TICKET_CATALOGUE_PATH || DEFAULT_PATH) => {
    if (catalogue && loadedPath === filename) return catalogue;
    try {
      const source = readFileSync(filename);
      if (source.length > 128 * 1024) throw new Error('Catalogue is too large');
      const parsed = parseTicketCatalogue(source.toString('utf8'));
      catalogue = parsed;
      loadedPath = filename;
      return catalogue;
    } catch (cause) {
      const error = new Error('Ticket catalogue is missing or invalid. Mount the ticket-catalogue ConfigMap at /etc/dashboard/ticket-catalogue (or set TICKET_CATALOGUE_PATH), check its staff/microscopes lists, then restart the dashboard.');
      error.status = 503;
      error.code = 'TICKET_CATALOGUE_CONFIG';
      throw error;
    }
  };
}

module.exports = { parseTicketCatalogue, createCatalogueLoader, getTicketCatalogue: createCatalogueLoader() };
