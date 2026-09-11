let chartInstance = null;
let omeroChartInstance = null;
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
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
  const requests = [fetchAndRenderOmeroHistory()];
  if (!omeroGroupsLoaded) requests.push(populateOmeroGroups());
  await Promise.all(requests);
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

    groups.forEach((group) => {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = group.name;
      groupSelect.appendChild(option);
    });
    omeroGroupsLoaded = true;
  } catch (error) {
    console.error('Error loading OMERO groups:', error);
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

  fetchAndRenderOmeroHistory();
});

document.getElementById('omeroGroupSelect').addEventListener('change', fetchAndRenderOmeroHistory);
document.getElementById('omeroMetricSelect').addEventListener('change', fetchAndRenderOmeroHistory);
document.getElementById('omeroStartDate').addEventListener('change', fetchAndRenderOmeroHistory);
document.getElementById('omeroEndDate').addEventListener('change', fetchAndRenderOmeroHistory);

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
