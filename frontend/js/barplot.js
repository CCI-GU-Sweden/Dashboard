let chartInstance = null;
let omeroChartInstance = null;
let filesetTableInstance = null;
let policyTableInstance = null;
let policiesLoaded = false;
const filesetDetailsCache = new Map();
let apiToken = sessionStorage.getItem('dashboardToken') || '';
let scopesLoaded = false;
let omeroGroupsLoaded = false;
let pendingView = null;

const overviewView = document.getElementById('overviewView');
const uploadsView = document.getElementById('uploadsView');
const omeroView = document.getElementById('omeroView');
const computeView = document.getElementById('computeView');
const customDateRange = document.getElementById('customDateRange');
const timePeriodSelect = document.getElementById('timePeriod');
const omeroCustomDateRange = document.getElementById('omeroCustomDateRange');
const omeroTimePeriodSelect = document.getElementById('omeroTimePeriod');
const views = {
  overview: overviewView,
  uploads: uploadsView,
  omero: omeroView,
  compute: computeView,
};
const viewPaths = {
  overview: '/',
  uploads: '/uploads',
  omero: '/omero',
  compute: '/compute',
};

function getViewFromPath() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return Object.keys(viewPaths).find((view) => viewPaths[view] === path) || 'overview';
}

function setAuthenticatedState(isAuthenticated) {
  const lockButton = document.getElementById('lock-icon');
  lockButton.innerHTML = isAuthenticated
    ? '<i class="fas fa-lock-open" aria-hidden="true"></i>'
    : '<i class="fas fa-lock" aria-hidden="true"></i>';
  lockButton.setAttribute('aria-label', isAuthenticated ? 'Dashboard unlocked' : 'Unlock dashboard');
  lockButton.title = isAuthenticated ? 'Dashboard unlocked' : 'Unlock dashboard';
}

function setupAuthentication(onUnlock) {
  const modal = document.getElementById('password-modal');
  const closeModal = document.getElementById('close-modal');
  const cancelButton = document.getElementById('cancel-btn');
  const passwordForm = document.getElementById('password-form');
  const passwordInput = document.getElementById('password-input');
  const passwordError = document.getElementById('password-error');
  const lockButton = document.getElementById('lock-icon');

  function resetModal() {
    passwordInput.value = '';
    passwordError.textContent = '';
    passwordError.hidden = true;
    passwordInput.classList.remove('is-danger');
  }

  function openModal() {
    resetModal();
    modal.classList.add('is-active');
    setTimeout(() => passwordInput.focus(), 100);
  }

  function closeModalDialog() {
    modal.classList.remove('is-active');
    resetModal();
  }

  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    try {
      const response = await fetch('/api/secure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput.value }),
      });
      const data = await response.json();

      if (!response.ok || !data.token) {
        throw new Error('Wrong password');
      }

      apiToken = data.token;
      sessionStorage.setItem('dashboardToken', apiToken);
      setAuthenticatedState(true);
      closeModalDialog();
      await onUnlock();
    } catch (error) {
      passwordError.textContent = error.message === 'Wrong password'
        ? 'Wrong password.'
        : 'Unable to contact the server.';
      passwordError.hidden = false;
      passwordInput.classList.add('is-danger');
    }
  });

  lockButton.addEventListener('click', openModal);
  closeModal.addEventListener('click', closeModalDialog);
  cancelButton.addEventListener('click', closeModalDialog);
  modal.querySelector('.modal-background').addEventListener('click', closeModalDialog);

  return openModal;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${apiToken}`,
    },
  });

  if (response.status === 401) {
    apiToken = '';
    sessionStorage.removeItem('dashboardToken');
    setAuthenticatedState(false);
    throw new Error('Your session has expired. Unlock the dashboard again.');
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Unable to load dashboard data.');
  }

  return response.json();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function renderOverview(summary) {
  document.getElementById('overviewPeriod').textContent =
    `${summary.period.from} to ${summary.period.to}`;
  document.getElementById('overviewUploadCount').textContent =
    Number(summary.uploads.count).toLocaleString();
  document.getElementById('overviewUploadBytes').textContent =
    formatBytes(Number(summary.uploads.total_bytes));
  document.getElementById('overviewTopMicroscope').textContent =
    summary.uploads.top_microscope || 'No uploads';

  if (summary.omero) {
    document.getElementById('overviewOmeroFilesets').textContent =
      formatNumber(summary.omero.fileset_count.value, 0);
    document.getElementById('overviewOmeroSize').textContent =
      `${formatNumber(summary.omero.total_size_gb.value, 2)} GB`;
    document.getElementById('overviewOmeroBillable').textContent =
      `${formatNumber(summary.omero.billable_sek.value, 2)} SEK`;
    renderChange(
      'overviewOmeroFilesetsChange',
      summary.omero.fileset_count.change_percent,
      summary.omero.comparison_date,
    );
    renderChange(
      'overviewOmeroSizeChange',
      summary.omero.total_size_gb.change_percent,
      summary.omero.comparison_date,
    );
    renderChange(
      'overviewOmeroBillableChange',
      summary.omero.billable_sek.change_percent,
      summary.omero.comparison_date,
    );
  }
}

function formatNumber(value, maximumFractionDigits = 2) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits });
}

function renderChange(elementId, change, comparisonDate) {
  const element = document.getElementById(elementId);
  element.classList.remove('change-positive', 'change-negative');

  if (change === null || change === undefined) {
    element.textContent = 'No comparison';
    return;
  }

  const numericChange = Number(change);
  const comparison = comparisonDate ? ` vs ${comparisonDate}` : '';
  element.textContent = `${numericChange >= 0 ? '+' : ''}${numericChange.toFixed(1)}%${comparison}`;

  if (numericChange > 0) element.classList.add('change-positive');
  if (numericChange < 0) element.classList.add('change-negative');
}

async function fetchOverview() {
  const errorElement = document.getElementById('overviewError');
  errorElement.hidden = true;

  try {
    renderOverview(await fetchJson('/api/summary'));
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

async function loadUploadsDashboard() {
  if (!scopesLoaded) await populateScopeDropdown();
  await fetchAndRenderStats();
}

async function loadOmeroDashboard() {
  const requests = [
    fetchAndRenderOmeroHistory(),
    fetchAndRenderOmeroSummary(),
    fetchAndRenderGroupRanking(),
  ];
  if (!omeroGroupsLoaded) requests.push(populateOmeroGroups());
  await Promise.all(requests);
  initializeFilesetTable();
  if (!document.getElementById('storagePoliciesPanel').hidden) await loadPolicies();
}

async function activateView(viewName, { historyMode = 'push', loadData = true } = {}) {
  const selectedView = views[viewName] ? viewName : 'overview';

  Object.entries(views).forEach(([name, element]) => {
    element.hidden = name !== selectedView;
  });

  if (historyMode !== 'none' && window.location.pathname !== viewPaths[selectedView]) {
    const historyMethod = historyMode === 'replace' ? 'replaceState' : 'pushState';
    window.history[historyMethod]({ view: selectedView }, '', viewPaths[selectedView]);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (!loadData || !apiToken) return;
  if (selectedView === 'overview') await fetchOverview();
  if (selectedView === 'uploads') await loadUploadsDashboard();
  if (selectedView === 'omero') await loadOmeroDashboard();
}

function openDashboard(viewName) {
  if (!apiToken) {
    pendingView = viewName;
    openAuthModal();
    return;
  }

  activateView(viewName);
}

function getSelectedFilters() {
  const filters = {
    scope: document.getElementById('scopeSelect').value,
    metric: document.getElementById('metricSelect').value,
  };

  if (timePeriodSelect.value === 'custom') {
    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;
    if (startDate && endDate) Object.assign(filters, { startDate, endDate });
  } else {
    filters.period = timePeriodSelect.value;
  }

  return filters;
}

async function populateScopeDropdown() {
  try {
    const scopes = await fetchJson('/api/uploads/scopes');
    const scopeSelect = document.getElementById('scopeSelect');

    scopes.forEach((scope) => {
      const option = document.createElement('option');
      option.value = scope;
      option.textContent = scope;
      scopeSelect.appendChild(option);
    });
    scopesLoaded = true;
  } catch (error) {
    console.error('Error loading scopes:', error);
  }
}

async function fetchAndRenderStats() {
  const filters = getSelectedFilters();
  const params = new URLSearchParams({ scope: filters.scope, metric: filters.metric });

  if (filters.startDate && filters.endDate) {
    params.set('startDate', filters.startDate);
    params.set('endDate', filters.endDate);
  } else if (filters.period) {
    params.set('period', filters.period);
  }

  try {
    const stats = await fetchJson(`/api/uploads/summary?${params}`);
    updateStatsUI(stats);
    updateChart(stats.chart_data, filters.metric);
  } catch (error) {
    console.error('Error fetching upload statistics:', error);
  }
}

function updateStatsUI(stats) {
  document.getElementById('statFiles').textContent = stats.total_files;
  document.getElementById('statSize').textContent = stats.total_size_mb;
  document.getElementById('statUsers').textContent = stats.unique_users;
  document.getElementById('statAvgImportSize').textContent = stats.avg_import_size;
  document.getElementById('statAvgTimePerMB').textContent = stats.avg_time_per_mb;
  document.getElementById('statAvgSizePerPeriod').textContent = stats.avg_size_per_period;
  document.getElementById('statAvgCountPerPeriod').textContent = stats.avg_count_per_period;
  document.getElementById('statScopeFiles').textContent = stats.top_scope_files
    ? `${stats.top_scope_files.name} (${stats.top_scope_files.count})`
    : '—';
  document.getElementById('statScopeSize').textContent = stats.top_scope_size
    ? `${stats.top_scope_size.name} (${stats.top_scope_size.size_mb} GB)`
    : '—';
  document.getElementById('statPeakDay').textContent = stats.peak_day
    ? `${stats.peak_day.date} (${stats.peak_day.count})`
    : '—';

  const periodChange = document.getElementById('statPeriodChange');
  const value = Number(stats.period_change);
  const icon = value > 0 ? 'arrow-up' : value < 0 ? 'arrow-down' : '';
  const colorClass = value > 0
    ? 'has-text-success'
    : value < 0
      ? 'has-text-danger'
      : 'has-text-grey';

  periodChange.className = colorClass;
  periodChange.textContent = `${value >= 0 ? '+' : ''}${value}%`;
  if (icon) periodChange.insertAdjacentHTML('beforeend', ` <i class="fas fa-${icon}"></i>`);
}

function updateChart(chartData, metric) {
  if (chartInstance) chartInstance.destroy();

  const context = document.getElementById('myChart').getContext('2d');
  chartInstance = new Chart(context, {
    type: 'bar',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, title: { display: true, text: 'Date' } },
        y: {
          stacked: true,
          beginAtZero: true,
          title: {
            display: true,
            text: metric === 'total_file_size_mb' ? 'Data (GB)' : 'Files',
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false },
      },
    },
  });
}

function getOmeroFilters() {
  const filters = {
    groupId: document.getElementById('omeroGroupSelect').value,
    metric: document.getElementById('omeroMetricSelect').value,
  };

  if (omeroTimePeriodSelect.value === 'custom') {
    const startDate = document.getElementById('omeroStartDate').value;
    const endDate = document.getElementById('omeroEndDate').value;
    if (startDate && endDate) Object.assign(filters, { startDate, endDate });
  } else {
    filters.period = omeroTimePeriodSelect.value;
  }

  return filters;
}

async function populateOmeroGroups() {
  try {
    const groups = await fetchJson('/api/omero/groups');
    const groupSelect = document.getElementById('omeroGroupSelect');
    const filesetGroupSelect = document.getElementById('filesetGroupSelect');

    groups.forEach((group) => {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = group.name;
      groupSelect.appendChild(option);
      filesetGroupSelect.appendChild(option.cloneNode(true));
    });
    omeroGroupsLoaded = true;
  } catch (error) {
    console.error('Error loading OMERO groups:', error);
  }
}

function formatFilesetDate(value, includeTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options = includeTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function buildFilesetDetails(fileset) {
  const details = document.createElement('div');
  details.className = 'fileset-details';
  const locations = Array.isArray(fileset.locations) ? fileset.locations : [];
  const locationText = locations.length
    ? locations.map((location) => {
      const project = location.project_name
        ? `${location.project_name} (ID ${location.project_id})`
        : 'No project';
      const dataset = location.dataset_name
        ? `${location.dataset_name} (ID ${location.dataset_id})`
        : 'No dataset';
      return `${project} / ${dataset}`;
    }).join('\n')
    : 'No project or dataset location';
  const fields = [
    ['OMERO location', locationText, 'is-wide'],
    ['Collected at', formatFilesetDate(fileset.first_seen_at, true)],
    ['Last seen', formatFilesetDate(fileset.last_seen_at, true)],
    ['Uncontained images', Number(fileset.uncontained_image_count).toLocaleString()],
    ['Missing runs', Number(fileset.missing_runs).toLocaleString()],
    [
      'Source files',
      Array.isArray(fileset.source_file_names) && fileset.source_file_names.length
        ? fileset.source_file_names.join('\n')
        : 'No source file names',
      'is-wide',
    ],
  ];

  if (fileset.missing_since_at) {
    fields.push(['Missing since', formatFilesetDate(fileset.missing_since_at, true)]);
  }
  if (fileset.deleted_at) {
    fields.push(['Deleted at', formatFilesetDate(fileset.deleted_at, true)]);
  }

  fields.forEach(([label, value, className]) => {
    const item = document.createElement('div');
    if (className) item.classList.add(className);
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    item.append(term, description);
    details.appendChild(item);
  });

  return details;
}

function getFilesetSort() {
  const preset = document.getElementById('filesetOrderSelect').value;
  return {
    largest: ['total_bytes', 'desc'],
    oldest: ['imported_at', 'asc'],
    newest: ['imported_at', 'desc'],
  }[preset] || ['total_bytes', 'desc'];
}

function reloadFilesetTable() {
  if (filesetTableInstance) filesetTableInstance.ajax.reload();
}

function initializeFilesetTable() {
  if (filesetTableInstance) {
    filesetTableInstance.ajax.reload(null, false);
    return;
  }

  const errorElement = document.getElementById('filesetTableError');
  filesetTableInstance = new DataTable('#filesetTable', {
    processing: true,
    serverSide: true,
    searching: false,
    ordering: false,
    pageLength: 50,
    lengthMenu: [25, 50, 100],
    scrollX: true,
    ajax(data, callback) {
      const [sort, order] = getFilesetSort();
      const params = new URLSearchParams({
        search: document.getElementById('filesetSearch').value.trim(),
        group_id: document.getElementById('filesetGroupSelect').value,
        status: document.getElementById('filesetStatusSelect').value,
        imported: document.getElementById('filesetImportedSelect').value,
        size: document.getElementById('filesetSizeSelect').value,
        billing: ['billable', 'overdue'].includes(document.getElementById('filesetOrderSelect').value)
          ? document.getElementById('filesetOrderSelect').value
          : 'all',
        page: String(Math.floor(data.start / data.length) + 1),
        pageSize: String(data.length),
        sort,
        order,
      });

      errorElement.hidden = true;
      fetchJson(`/api/omero/filesets?${params}`)
        .then((result) => callback({
          draw: data.draw,
          recordsTotal: result.total,
          recordsFiltered: result.filteredTotal,
          data: result.data,
        }))
        .catch((error) => {
          errorElement.textContent = error.message;
          errorElement.hidden = false;
          callback({ draw: data.draw, recordsTotal: 0, recordsFiltered: 0, data: [] });
        });
    },
    columns: [
      {
        data: null,
        className: 'fileset-detail-control',
        defaultContent: '',
        render() {
          return '<button class="fileset-detail-button" type="button" aria-expanded="false" aria-label="Show fileset details"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>';
        },
      },
      { data: 'fileset_id', render: DataTable.render.text() },
      {
        data: null,
        render(data, type, row) {
          const fullName = [row.firstname, row.lastname].filter(Boolean).join(' ');
          const owner = fullName ? `${fullName} (${row.username})` : row.username || '—';
          return type === 'display' ? DataTable.render.text().display(owner) : row.username;
        },
      },
      { data: 'group_name', defaultContent: '—', render: DataTable.render.text() },
      { data: 'imported_at', render: (value) => formatFilesetDate(value) },
      { data: 'source_file_count', render: DataTable.render.number(null, null, 0) },
      { data: 'image_count', render: DataTable.render.number(null, null, 0) },
      { data: 'total_bytes', render: (value) => formatBytes(Number(value)) },
      {
        data: 'deleted_at',
        render(value, type) {
          if (type !== 'display') return value || '';
          return value
            ? `<span class="fileset-status is-deleted" title="Deleted ${formatFilesetDate(value)}">Deleted</span>`
            : '<span class="fileset-status is-active">Active</span>';
        },
      },
    ],
  });

  document.querySelector('#filesetTable tbody').addEventListener('click', async (event) => {
    const button = event.target.closest('.fileset-detail-button');
    if (!button) return;

    const tableRow = button.closest('tr');
    const row = filesetTableInstance.row(tableRow);
    if (row.child.isShown()) {
      row.child.hide();
      tableRow.classList.remove('details-open');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', 'Show fileset details');
      return;
    }

    const filesetId = String(row.data().fileset_id);
    const loading = document.createElement('div');
    loading.className = 'fileset-details-loading';
    loading.textContent = 'Loading details…';
    row.child(loading).show();
    tableRow.classList.add('details-open');
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-label', 'Hide fileset details');
    button.disabled = true;

    try {
      if (!filesetDetailsCache.has(filesetId)) {
        filesetDetailsCache.set(filesetId, await fetchJson(`/api/omero/filesets/${filesetId}`));
      }
      row.child(buildFilesetDetails(filesetDetailsCache.get(filesetId))).show();
    } catch (error) {
      const errorMessage = document.createElement('div');
      errorMessage.className = 'fileset-details-error';
      errorMessage.textContent = error.message;
      row.child(errorMessage).show();
    } finally {
      button.disabled = false;
    }
  });
}

function policyBadgeMarkup(policyType) {
  const badgeClass = {
    CORE: 'is-core',
    AGREEMENT: 'is-agreement',
    TEMPORARY: 'is-temporary',
  }[policyType] || 'is-core';
  return `<span class="policy-badge ${badgeClass}">${policyType}</span>`;
}

function formatPolicyDate(value) {
  if (!value) return '—';
  return String(value).slice(0, 10);
}

function formatPolicyRate(value) {
  return `${Number(value || 0).toFixed(4)} öre / GB / day`;
}

function groupPolicyHistory(policies) {
  const groups = new Map();
  policies.forEach((policy) => {
    const key = String(policy.group_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(policy);
  });

  return [...groups.values()].map((history) => {
    history.sort((left, right) => String(right.valid_from).localeCompare(String(left.valid_from)));
    return { ...history[0], history };
  });
}

function buildPolicyHistory(policy) {
  const wrapper = document.createElement('div');
  wrapper.className = 'policy-history';
  const table = document.createElement('table');
  table.className = 'policy-history-table';
  table.innerHTML = '<thead><tr><th>Policy</th><th>From</th><th>Until</th><th>Rate</th><th>Status</th><th>Notes</th></tr></thead>';
  const body = document.createElement('tbody');

  policy.history.forEach((entry) => {
    const row = document.createElement('tr');
    const cells = [
      entry.policy_type,
      formatPolicyDate(entry.valid_from),
      formatPolicyDate(entry.valid_until),
      formatPolicyRate(entry.rate_ore_per_gb_day),
      entry.effective_status,
      entry.notes || '—',
    ];
    cells.forEach((value, index) => {
      const cell = document.createElement('td');
      if (index === 0) cell.innerHTML = policyBadgeMarkup(value);
      else cell.textContent = value;
      row.appendChild(cell);
    });
    body.appendChild(row);
  });

  table.appendChild(body);
  wrapper.appendChild(table);
  return wrapper;
}

function initializePolicyTable(policies) {
  const data = groupPolicyHistory(policies);
  if (policyTableInstance) {
    policyTableInstance.clear().rows.add(data).draw();
    return;
  }

  policyTableInstance = new DataTable('#policyTable', {
    data,
    pageLength: 25,
    order: [[1, 'asc']],
    scrollX: true,
    columns: [
      {
        data: null,
        orderable: false,
        className: 'fileset-detail-control',
        render: () => '<button class="policy-history-button" type="button" aria-expanded="false" aria-label="Show policy history"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>',
      },
      { data: 'group_name', render: DataTable.render.text() },
      { data: 'policy_type', render: (value, type) => (type === 'display' ? policyBadgeMarkup(value) : value) },
      {
        data: 'grace_days',
        render: (value, type) => (type === 'display'
          ? value === null ? '—' : `${value} days`
          : value ?? -1),
      },
      {
        data: 'billing_grace_days',
        render: (value, type) => (type === 'display' ? `${value} days` : Number(value)),
      },
      {
        data: 'rate_ore_per_gb_day',
        render: (value, type) => (type === 'display' ? formatPolicyRate(value) : Number(value)),
      },
      { data: 'valid_from', render: formatPolicyDate },
      { data: 'valid_until', render: formatPolicyDate },
      { data: 'notes', defaultContent: '—', render: DataTable.render.text() },
      {
        data: null,
        orderable: false,
        render: () => '<button class="button is-small is-link is-light policy-edit-button" type="button"><span class="icon is-small"><i class="fas fa-pen" aria-hidden="true"></i></span><span>Edit</span></button>',
      },
    ],
  });

  document.querySelector('#policyTable tbody').addEventListener('click', (event) => {
    const tableRow = event.target.closest('tr');
    if (!tableRow) return;
    const row = policyTableInstance.row(tableRow);
    const historyButton = event.target.closest('.policy-history-button');
    if (historyButton) {
      if (row.child.isShown()) {
        row.child.hide();
        tableRow.classList.remove('details-open');
        historyButton.setAttribute('aria-expanded', 'false');
      } else {
        row.child(buildPolicyHistory(row.data())).show();
        tableRow.classList.add('details-open');
        historyButton.setAttribute('aria-expanded', 'true');
      }
      return;
    }

    if (event.target.closest('.policy-edit-button')) openPolicyModal(row.data());
  });
}

async function loadPolicies() {
  const errorElement = document.getElementById('policyTableError');
  errorElement.hidden = true;
  try {
    const response = await fetchJson('/api/omero/policies');
    initializePolicyTable(response.data || []);
    policiesLoaded = true;
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

function stockholmToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function nextDate(dateValue) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function updatePolicyFormForType(resetDefaults = false) {
  const policyType = document.getElementById('policyType').value;
  const graceInput = document.getElementById('policyGraceDays');
  const graceHelp = document.getElementById('policyGraceHelp');
  const rateInput = document.getElementById('policyRate');
  const billingGraceInput = document.getElementById('policyBillingGraceDays');

  graceInput.disabled = policyType !== 'TEMPORARY';
  rateInput.disabled = policyType === 'CORE';
  if (policyType === 'TEMPORARY') {
    if (resetDefaults || !graceInput.value) graceInput.value = '90';
    if (resetDefaults) billingGraceInput.value = '7';
    if (resetDefaults || !rateInput.value || Number(rateInput.value) === 0) rateInput.value = '5.0000';
    graceHelp.textContent = '';
  } else if (policyType === 'AGREEMENT') {
    graceInput.value = '0';
    if (resetDefaults) billingGraceInput.value = '0';
    if (resetDefaults || !rateInput.value || Number(rateInput.value) === 0) rateInput.value = '2.0000';
    graceHelp.textContent = 'Fixed at 0 days for agreement policies.';
  } else {
    graceInput.value = '';
    if (resetDefaults) billingGraceInput.value = '0';
    rateInput.value = '0.0000';
    graceHelp.textContent = 'Not applicable to core policies.';
  }
}

function openPolicyModal(policy) {
  const today = stockholmToday();
  const suggestedDate = nextDate(formatPolicyDate(policy.valid_from));
  document.getElementById('policyGroupId').value = policy.group_id;
  document.getElementById('policyGroupName').value = policy.group_name;
  document.getElementById('policyType').value = policy.policy_type;
  document.getElementById('policyGraceDays').value = policy.grace_days ?? '';
  document.getElementById('policyBillingGraceDays').value = policy.billing_grace_days;
  document.getElementById('policyRate').value = Number(policy.rate_ore_per_gb_day).toFixed(4);
  document.getElementById('policyValidFrom').min = today;
  document.getElementById('policyValidFrom').value = suggestedDate > today ? suggestedDate : today;
  document.getElementById('policyNotes').value = policy.notes || '';
  document.getElementById('policyFormError').hidden = true;
  updatePolicyFormForType();
  document.getElementById('policy-modal').classList.add('is-active');
  setTimeout(() => document.getElementById('policyType').focus(), 100);
}

function closePolicyModal() {
  document.getElementById('policy-modal').classList.remove('is-active');
  document.getElementById('policyForm').reset();
  document.getElementById('policyFormError').hidden = true;
}

function activateOmeroDataTab(tab) {
  const showPolicies = tab === 'policies';
  document.getElementById('filesetInventoryPanel').hidden = showPolicies;
  document.getElementById('storagePoliciesPanel').hidden = !showPolicies;
  const filesetTab = document.getElementById('filesetInventoryTab');
  const policiesTab = document.getElementById('storagePoliciesTab');
  filesetTab.parentElement.classList.toggle('is-active', !showPolicies);
  policiesTab.parentElement.classList.toggle('is-active', showPolicies);
  filesetTab.setAttribute('aria-selected', String(!showPolicies));
  policiesTab.setAttribute('aria-selected', String(showPolicies));

  if (showPolicies) {
    if (!policiesLoaded) loadPolicies();
    else policyTableInstance?.columns.adjust();
  } else {
    filesetTableInstance?.columns.adjust();
  }
}

async function fetchAndRenderOmeroHistory() {
  const filters = getOmeroFilters();
  const params = new URLSearchParams({
    groupId: filters.groupId,
    metric: filters.metric,
  });
  const errorElement = document.getElementById('omeroChartError');

  if (filters.startDate && filters.endDate) {
    params.set('startDate', filters.startDate);
    params.set('endDate', filters.endDate);
  } else if (filters.period) {
    params.set('period', filters.period);
  }

  errorElement.hidden = true;

  try {
    renderOmeroChart(await fetchJson(`/api/omero/history?${params}`));
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

async function fetchAndRenderOmeroSummary() {
  const filters = getOmeroFilters();
  const params = new URLSearchParams();

  if (filters.startDate && filters.endDate) {
    params.set('startDate', filters.startDate);
    params.set('endDate', filters.endDate);
  } else if (filters.period) {
    params.set('period', filters.period);
  }

  try {
    renderOmeroSummary(await fetchJson(`/api/omero/summary?${params}`));
  } catch (error) {
    console.error('Error loading OMERO summary:', error);
  }
}

async function fetchAndRenderGroupRanking() {
  const filters = getOmeroFilters();
  const params = new URLSearchParams();
  const errorElement = document.getElementById('groupRankingError');

  if (filters.startDate && filters.endDate) {
    params.set('startDate', filters.startDate);
    params.set('endDate', filters.endDate);
  } else if (filters.period) {
    params.set('period', filters.period);
  }

  errorElement.hidden = true;
  try {
    renderGroupRanking(await fetchJson(`/api/omero/groups/ranking?${params}`));
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

function formatTrend(change) {
  if (change === null || change === undefined) return 'No comparison';
  const numericChange = Number(change);
  return `${numericChange >= 0 ? '+' : ''}${numericChange.toFixed(1)}%`;
}

function renderGroupRanking(data) {
  const chart = document.getElementById('groupRankingChart');
  const period = document.getElementById('groupRankingPeriod');
  const groups = data.groups || [];
  period.textContent = data.comparison_date
    ? `${data.snapshot_date} vs ${data.comparison_date}`
    : data.snapshot_date || 'No snapshots available';

  if (!groups.length) {
    Plotly.purge(chart);
    chart.textContent = 'No group storage data is available for this period.';
    chart.classList.add('is-empty');
    return;
  }

  chart.classList.remove('is-empty');
  chart.textContent = '';
  const labels = groups.map((group) => group.group_name);
  const values = groups.map((group) => Number(group.billable_gb));
  const text = groups.map((group) =>
    `${formatNumber(group.billable_gb, 1)} GB · ${formatTrend(group.change_percent)}`);
  const customdata = groups.map((group) => [
    group.group_id,
    formatTrend(group.change_percent),
    group.billable_fileset_count,
    group.daily_charge_sek,
    group.previous_billable_gb === null
      ? 'No comparison'
      : `${formatNumber(group.previous_billable_gb, 2)} GB`,
  ]);

  Plotly.react(chart, [{
    type: 'bar',
    orientation: 'h',
    x: values,
    y: labels,
    text,
    textposition: 'outside',
    cliponaxis: false,
    marker: { color: '#2457d6' },
    customdata,
    hovertemplate: [
      '<b>%{y}</b>',
      '<br>Billable storage: %{x:,.2f} GB',
      '<br>Change: %{customdata[1]}',
      '<br>Previous billable storage: %{customdata[4]}',
      '<br>Billable filesets: %{customdata[2]:,.0f}',
      '<br>Daily charge: %{customdata[3]:,.2f} SEK',
      '<extra></extra>',
    ].join(''),
  }], {
    height: Math.max(360, groups.length * 42 + 100),
    margin: { l: 170, r: 150, t: 10, b: 55 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'inherit', color: '#24324a' },
    bargap: 0.28,
    xaxis: {
      title: 'Billable storage (GB)',
      rangemode: 'tozero',
      gridcolor: '#e2e8f0',
      zeroline: false,
    },
    yaxis: {
      categoryorder: 'array',
      categoryarray: labels,
      autorange: 'reversed',
      automargin: true,
    },
  }, {
    responsive: true,
    displayModeBar: false,
  });

  if (typeof chart.removeAllListeners === 'function') chart.removeAllListeners('plotly_click');
  chart.on('plotly_click', (event) => {
    const groupId = String(event.points[0].customdata[0]);
    const groupSelect = document.getElementById('filesetGroupSelect');
    activateOmeroDataTab('filesets');
    groupSelect.value = groupId;
    reloadFilesetTable();
    document.getElementById('filesetTableTitle').scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  });
}

function renderOmeroSummary(summary) {
  const cards = [
    ['fileset_count', 'omeroFilesetCount', 'omeroFilesetCountChange', 0, ''],
    ['billable_fileset_count', 'omeroBillableFilesetCount', 'omeroBillableFilesetCountChange', 0, ''],
    ['total_size_gb', 'omeroTotalSize', 'omeroTotalSizeChange', 2, ' GB'],
    [
      'agreement_billable_size_gb',
      'omeroAgreementBillableSize',
      'omeroAgreementBillableSizeChange',
      2,
      ' GB',
    ],
    [
      'non_agreement_billable_size_gb',
      'omeroNonAgreementBillableSize',
      'omeroNonAgreementBillableSizeChange',
      2,
      ' GB',
    ],
    ['overdue_fileset_count', 'omeroOverdueFilesetCount', 'omeroOverdueFilesetCountChange', 0, ''],
    ['billable_sek', 'omeroBillableSek', 'omeroBillableSekChange', 2, ' SEK'],
  ];

  cards.forEach(([metricName, valueId, changeId, digits, suffix]) => {
    const value = summary.metrics[metricName];
    document.getElementById(valueId).textContent =
      `${formatNumber(value.value, digits)}${suffix}`;
    renderChange(changeId, value.change_percent, summary.comparison_date);
  });
}

function renderOmeroChart(data) {
  if (omeroChartInstance) omeroChartInstance.destroy();

  const context = document.getElementById('omeroChart').getContext('2d');
  const labels = data.history.map((point) => point.date);
  const unit = data.unit;

  omeroChartInstance = new Chart(context, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Total',
          data: data.history.map((point) => point.total),
          borderColor: '#2457d6',
          backgroundColor: '#2457d6',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5,
          tension: 0.2,
        },
        {
          label: 'Billable',
          data: data.history.map((point) => point.billable),
          borderColor: '#d97706',
          backgroundColor: '#d97706',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5,
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { title: { display: true, text: 'Date' } },
        y: {
          beginAtZero: true,
          title: { display: true, text: unit },
        },
      },
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: {
          callbacks: {
            label(context) {
              const value = Number(context.parsed.y).toLocaleString(undefined, {
                maximumFractionDigits: 2,
              });
              return `${context.dataset.label}: ${value} ${unit}`;
            },
          },
        },
      },
    },
  });
}

function updateCustomDateVisibility() {
  customDateRange.style.display = timePeriodSelect.value === 'custom' ? 'flex' : 'none';
}

function updateOmeroCustomDateVisibility() {
  omeroCustomDateRange.style.display = omeroTimePeriodSelect.value === 'custom' ? 'flex' : 'none';
}

function refreshOmeroDashboard() {
  return Promise.all([
    fetchAndRenderOmeroHistory(),
    fetchAndRenderOmeroSummary(),
    fetchAndRenderGroupRanking(),
  ]);
}

async function handleUnlock() {
  const viewName = pendingView || getViewFromPath();
  pendingView = null;
  await activateView(viewName);
}

const openAuthModal = setupAuthentication(handleUnlock);

function makeCardNavigable(cardId, viewName) {
  const card = document.getElementById(cardId);
  card.addEventListener('click', () => openDashboard(viewName));
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDashboard(viewName);
    }
  });
}

makeCardNavigable('uploadsCard', 'uploads');
makeCardNavigable('omeroCard', 'omero');
makeCardNavigable('computeCard', 'compute');

document.getElementById('backToOverview').addEventListener('click', () => activateView('overview'));
document.querySelectorAll('.dashboard-back').forEach((button) => {
  button.addEventListener('click', () => activateView('overview'));
});
document.getElementById('overviewHome').addEventListener('click', () => activateView('overview'));

document.getElementById('exportPageBtn').addEventListener('click', async () => {
  const exportButton = document.getElementById('exportPageBtn');
  exportButton.hidden = true;
  const canvas = await html2canvas(uploadsView);
  const link = document.createElement('a');
  link.download = 'uploads-dashboard.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
  exportButton.hidden = false;
});

timePeriodSelect.addEventListener('change', () => {
  updateCustomDateVisibility();

  if (timePeriodSelect.value === 'custom') {
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 30);
    document.getElementById('startDate').valueAsDate = startDate;
    document.getElementById('endDate').valueAsDate = endDate;
  }

  fetchAndRenderStats();
});

document.getElementById('scopeSelect').addEventListener('change', fetchAndRenderStats);
document.getElementById('metricSelect').addEventListener('change', fetchAndRenderStats);
document.getElementById('startDate').addEventListener('change', fetchAndRenderStats);
document.getElementById('endDate').addEventListener('change', fetchAndRenderStats);

omeroTimePeriodSelect.addEventListener('change', () => {
  updateOmeroCustomDateVisibility();

  if (omeroTimePeriodSelect.value === 'custom') {
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 30);
    document.getElementById('omeroStartDate').valueAsDate = startDate;
    document.getElementById('omeroEndDate').valueAsDate = endDate;
  }

  refreshOmeroDashboard();
});

document.getElementById('omeroGroupSelect').addEventListener('change', fetchAndRenderOmeroHistory);
document.getElementById('omeroMetricSelect').addEventListener('change', fetchAndRenderOmeroHistory);
document.getElementById('omeroStartDate').addEventListener('change', refreshOmeroDashboard);
document.getElementById('omeroEndDate').addEventListener('change', refreshOmeroDashboard);

document.getElementById('filesetInventoryTab').addEventListener('click', () => {
  activateOmeroDataTab('filesets');
});
document.getElementById('storagePoliciesTab').addEventListener('click', () => {
  activateOmeroDataTab('policies');
});

document.getElementById('policyType').addEventListener('change', () => {
  updatePolicyFormForType(true);
});
document.getElementById('closePolicyModal').addEventListener('click', closePolicyModal);
document.getElementById('cancelPolicyEdit').addEventListener('click', closePolicyModal);
document.querySelector('#policy-modal .modal-background').addEventListener('click', closePolicyModal);
document.getElementById('policyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const saveButton = document.getElementById('savePolicy');
  const errorElement = document.getElementById('policyFormError');
  const policyType = document.getElementById('policyType').value;
  errorElement.hidden = true;
  saveButton.disabled = true;
  saveButton.classList.add('is-loading');

  try {
    await fetchJson('/api/omero/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_id: document.getElementById('policyGroupId').value,
        policy_type: policyType,
        grace_days: policyType === 'TEMPORARY'
          ? document.getElementById('policyGraceDays').value
          : null,
        billing_grace_days: document.getElementById('policyBillingGraceDays').value,
        rate_ore_per_gb_day: policyType === 'CORE'
          ? '0'
          : document.getElementById('policyRate').value,
        valid_from: document.getElementById('policyValidFrom').value,
        notes: document.getElementById('policyNotes').value,
      }),
    });
    closePolicyModal();
    await loadPolicies();
    reloadFilesetTable();
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  } finally {
    saveButton.disabled = false;
    saveButton.classList.remove('is-loading');
  }
});

let filesetSearchTimer;
document.getElementById('filesetSearch').addEventListener('input', () => {
  window.clearTimeout(filesetSearchTimer);
  filesetSearchTimer = window.setTimeout(reloadFilesetTable, 300);
});
[
  'filesetGroupSelect',
  'filesetStatusSelect',
  'filesetImportedSelect',
  'filesetSizeSelect',
  'filesetOrderSelect',
].forEach((id) => document.getElementById(id).addEventListener('change', reloadFilesetTable));

updateCustomDateVisibility();
updateOmeroCustomDateVisibility();
setAuthenticatedState(Boolean(apiToken));

const initialView = getViewFromPath();
activateView(initialView, { historyMode: 'replace', loadData: Boolean(apiToken) });

if (!apiToken && initialView !== 'overview') {
  pendingView = initialView;
  openAuthModal();
}

window.addEventListener('popstate', () => {
  const viewName = getViewFromPath();

  if (!apiToken && viewName !== 'overview') {
    pendingView = viewName;
    activateView(viewName, { historyMode: 'none', loadData: false });
    openAuthModal();
    return;
  }

  activateView(viewName, { historyMode: 'none' });
});
