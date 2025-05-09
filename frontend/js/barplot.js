let chartInstance = null;

function getSelectedFilters() {
  return {
    scope: document.getElementById('scopeSelect').value,
    period: document.getElementById('timePeriod').value,
    metric: document.getElementById('metricSelect').value,
  };
}

function populateScopeDropdown() {
  fetch('/api/scopes', {
    headers: {
      'Authorization': 'Bearer mytesttoken'
    }
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
    headers: {
      'Authorization': 'Bearer mytesttoken'
    }
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
