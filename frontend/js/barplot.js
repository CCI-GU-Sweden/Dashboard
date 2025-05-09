let chartInstance = null;
let apiToken = '';

function showPasswordModal(onUnlock) {
  const modal = document.getElementById('password-modal');
  const closeModal = document.getElementById('close-modal');
  const unlockBtn = document.getElementById('unlock-btn');
  const passwordInput = document.getElementById('password-input');
  const passwordError = document.getElementById('password-error');
  const lockIcon = document.getElementById('lock-icon');

  // Show modal
  modal.style.display = 'block';
  passwordInput.value = '';
  passwordError.textContent = '';
  passwordInput.focus();

  // Close modal handler
  closeModal.onclick = () => { modal.style.display = 'none'; };

  // Click outside modal to close
  window.onclick = (event) => {
    if (event.target === modal) modal.style.display = 'none';
  };

  // Unlock handler
  function handleUnlock() {
    const password = passwordInput.value;
    fetch('/api/secure', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ password })
    })
    .then(res => res.json())
    .then(data => {
      if (data.token) {
        apiToken = data.token;
        modal.style.display = 'none';
        lockIcon.textContent = '🔓';
        if (onUnlock) onUnlock();
      } else {
        passwordError.textContent = 'Wrong password!';
      }
    })
    .catch(() => {
      passwordError.textContent = 'Error contacting server!';
    });
  }

  unlockBtn.onclick = handleUnlock;
  passwordInput.onkeyup = function(event) {
    if (event.key === 'Enter') handleUnlock();
  };
}

// Attach to lock icon
document.getElementById('lock-icon').onclick = function() {
  showPasswordModal(() => {
    // Optional: refresh data or unlock UI
    populateScopeDropdown();
    fetchAndRenderStats();
  });
};


function getSelectedFilters() {
  return {
    scope: document.getElementById('scopeSelect').value,
    period: document.getElementById('timePeriod').value,
    metric: document.getElementById('metricSelect').value,
  };
}

function populateScopeDropdown() {
  fetch('/api/scopes', {
    headers: {'Authorization': 'Bearer ' + apiToken}
  })
    .then(res => res.json())
    .then(scopes => {
      const scopeSelect = document.getElementById('scopeSelect');
      scopes.forEach(scope => {
        const option = document.createElement('option');
        option.value = scope;
        option.textContent = scope;
        scopeSelect.appendChild(option);
      });
    })
    .catch(err => {
      console.error('Error loading scopes:', err);
    });
}

function fetchAndRenderStats() {
  const { scope, period, metric } = getSelectedFilters();

  fetch(`/api/stats?scope=${scope}&period=${period}&metric=${metric}`, {
    headers: {'Authorization': 'Bearer ' + apiToken}
  })
    .then(response => response.json())
    .then(stats => {
      updateStatsUI(stats);
      updateChart(stats.chart_data);
    })
    .catch(err => {
      console.error('Error fetching stats:', err);
    });
}

function updateStatsUI(stats) {
  document.getElementById('statFiles').textContent = stats.total_files;
  document.getElementById('statSize').textContent = stats.total_size_mb;
  document.getElementById('statUsers').textContent = stats.unique_users;
  document.getElementById('statAvgImportSize').textContent = stats.avg_import_size;
  document.getElementById('statAvgTimePerMB').textContent = stats.avg_time_per_mb;
  document.getElementById('statPeriodChange').textContent =
    (stats.period_change >= 0 ? '+' : '') + stats.period_change + '%';

  const topScopeFiles = stats.top_scope_files;
  const topScopeSize = stats.top_scope_size;
  const peakDay = stats.peak_day;

  document.getElementById('statScopeFiles').textContent = topScopeFiles
    ? `${topScopeFiles.name} (${topScopeFiles.count})` : '-';
  document.getElementById('statScopeSize').textContent = topScopeSize
    ? `${topScopeSize.name} (${topScopeSize.size_mb} MB)` : '-';
  document.getElementById('statPeakDay').textContent = peakDay
    ? `${peakDay.date} (${peakDay.count})` : '-';
}

function updateChart(chartData) {
  if (chartInstance) chartInstance.destroy();

  const ctx = document.getElementById('myChart').getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: chartData.labels,
      datasets: [{
        label: chartData.label,
        data: chartData.values,
        backgroundColor: 'rgba(54, 162, 235, 0.5)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: 'Date' },
          ticks: { autoSkip: true, maxTicksLimit: 10 }
        },
        y: {
          title: { display: true, text: chartData.label },
          beginAtZero: true
        }
      },
      plugins: {
        legend: {
          display: false
        }
      }
    }
  });
}

// Export PNG (unchanged)
document.getElementById("exportPageBtn").addEventListener("click", () => {
  const exportButton = document.getElementById("exportPageBtn");
  exportButton.style.display = "none";
  html2canvas(document.body).then(canvas => {
    const link = document.createElement("a");
    link.download = "dashboard.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
    exportButton.style.display = "";
  });
});

// Filter triggers
document.getElementById('timePeriod').addEventListener('change', fetchAndRenderStats);
document.getElementById('scopeSelect').addEventListener('change', fetchAndRenderStats);
document.getElementById('metricSelect').addEventListener('change', fetchAndRenderStats);

// Initial call
populateScopeDropdown();
fetchAndRenderStats();
