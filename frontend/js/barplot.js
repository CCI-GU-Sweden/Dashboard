let chartInstance = null;
let apiToken = sessionStorage.getItem('dashboardToken') || '';
let scopesLoaded = false;
let openUploadsAfterUnlock = false;

const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
const isUploadsPage = currentPath === '/uploads';

const overviewView = document.getElementById('overviewView');
const uploadsView = document.getElementById('uploadsView');
const customDateRange = document.getElementById('customDateRange');
const timePeriodSelect = document.getElementById('timePeriod');

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

function showOverview() {
  if (isUploadsPage) {
    window.location.assign('/');
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function showUploads() {
  if (!apiToken) {
    openUploadsAfterUnlock = true;
    openAuthModal();
    return;
  }

  window.location.assign('/uploads');
}

async function loadUploadsDashboard() {
  overviewView.hidden = true;
  uploadsView.hidden = false;

  if (!scopesLoaded) await populateScopeDropdown();
  await fetchAndRenderStats();
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

function updateCustomDateVisibility() {
  customDateRange.style.display = timePeriodSelect.value === 'custom' ? 'flex' : 'none';
}

async function handleUnlock() {
  if (isUploadsPage) {
    await loadUploadsDashboard();
    return;
  }

  if (openUploadsAfterUnlock) {
    openUploadsAfterUnlock = false;
    window.location.assign('/uploads');
    return;
  }

  await fetchOverview();
}

const openAuthModal = setupAuthentication(handleUnlock);

document.getElementById('uploadsCard').addEventListener('click', showUploads);
document.getElementById('uploadsCard').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    showUploads();
  }
});
document.getElementById('backToOverview').addEventListener('click', showOverview);
document.getElementById('overviewHome').addEventListener('click', showOverview);

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

updateCustomDateVisibility();
setAuthenticatedState(Boolean(apiToken));

if (isUploadsPage) {
  overviewView.hidden = true;
  uploadsView.hidden = false;

  if (apiToken) {
    loadUploadsDashboard();
  } else {
    openAuthModal();
  }
} else {
  overviewView.hidden = false;
  uploadsView.hidden = true;
  if (apiToken) fetchOverview();
}
