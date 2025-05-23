let chartInstance = null;
let apiToken = '';

function showBulmaPasswordModal(onUnlock) {
  const modal = document.getElementById('password-modal');
  const closeModal = document.getElementById('close-modal');
  const cancelBtn = document.getElementById('cancel-btn');
  const passwordForm = document.getElementById('password-form');
  const passwordInput = document.getElementById('password-input');
  const passwordError = document.getElementById('password-error');
  const lockIcon = document.getElementById('lock-icon');

  function resetModal() {
    passwordInput.value = '';
    passwordError.textContent = '';
    passwordError.style.display = 'none';
    passwordInput.classList.remove('is-danger');
  }

  function openModal() {
    modal.classList.add('is-active');
    resetModal();
    setTimeout(() => passwordInput.focus(), 100);
  }

  function closeModalFunc() {
    modal.classList.remove('is-active');
    resetModal();
  }

  function handleUnlock(event) {
    event.preventDefault(); // Prevent form from submitting normally
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
        closeModalFunc();
        lockIcon.textContent = '🔓';
        if (onUnlock) onUnlock();
      } else {
        passwordError.textContent = 'Wrong password!';
        passwordError.style.display = '';
        passwordInput.classList.add('is-danger');
      }
    })
    .catch(() => {
      passwordError.textContent = 'Error contacting server!';
      passwordError.style.display = '';
      passwordInput.classList.add('is-danger');
    });
  }

  // Event listeners
  lockIcon.onclick = openModal;
  closeModal.onclick = closeModalFunc;
  cancelBtn.onclick = closeModalFunc;
  passwordForm.onsubmit = handleUnlock;
  // Optional: close modal on background click
  modal.querySelector('.modal-background').onclick = closeModalFunc;
}


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

	const topScopeFiles = stats.top_scope_files;
	const topScopeSize = stats.top_scope_size;
	const peakDay = stats.peak_day;

	document.getElementById('statScopeFiles').textContent = topScopeFiles
	? `${topScopeFiles.name} (${topScopeFiles.count})` : '-';
	document.getElementById('statScopeSize').textContent = topScopeSize
	? `${topScopeSize.name} (${topScopeSize.size_mb} GB)` : '-';
	document.getElementById('statPeakDay').textContent = peakDay
	? `${peakDay.date} (${peakDay.count})` : '-';

	const el = document.getElementById('statPeriodChange');
	const value = stats.period_change;
	const sign = value >= 0 ? '+' : '';
	el.textContent = `${sign}${value}%`;

	// Remove previous color classes and icon
	el.classList.remove('has-text-success', 'has-text-danger', 'has-text-grey');
	const existingIcon = el.querySelector('i');
	if (existingIcon) existingIcon.remove();

	// Add color class and icon
	if (value > 0) {
	  el.classList.add('has-text-success');
	  el.insertAdjacentHTML('beforeend', ' <i class="fas fa-arrow-up"></i>');
	} else if (value < 0) {
	  el.classList.add('has-text-danger');
	  el.insertAdjacentHTML('beforeend', ' <i class="fas fa-arrow-down"></i>');
	} else {
	  el.classList.add('has-text-grey');
	}
}

function updateChart(chartData) {
  if (chartInstance) chartInstance.destroy();

  const ctx = document.getElementById('myChart').getContext('2d');
  
  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
			stacked: true,
			title: { display: true, text: 'Date' },
			ticks: { autoSkip: true, maxTicksLimit: 10 }
        },
        y: {
			stacked: true,
			title: { display: true, text: chartData.label },
			beginAtZero: true
        }
      },
      plugins: {
        legend: {
          display: false
        },
	  tooltip: {
        mode: 'index',
        intersect: false
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

showBulmaPasswordModal(() => {
  // Refresh data or unlock UI here
  populateScopeDropdown();
  fetchAndRenderStats();
});
