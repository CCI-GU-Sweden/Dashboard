let chartInstance = null;
let allData = [];

function getSelectedFilters() {
  return {
    scope: document.getElementById('scopeSelect').value,
    period: document.getElementById('timePeriod').value,
    metric: document.getElementById('metricSelect').value,
  };
}

function fetchDataAndUpdate() {
  const { scope, period, metric } = getSelectedFilters();

  fetch(`/imports?scope=${scope}&period=${period}&metric=${metric}`)
    .then(response => response.json())
    .then(data => {
      allData = data;
      populateScopeDropdown(data);
      updateChart();
    })
    .catch(err => console.error('Error fetching data:', err));
}

document.getElementById('timePeriod').addEventListener('change', fetchDataAndUpdate);
document.getElementById('scopeSelect').addEventListener('change', fetchDataAndUpdate);
document.getElementById('metricSelect').addEventListener('change', fetchDataAndUpdate);

// initial load
fetchDataAndUpdate();

// Populate the scope dropdown with unique scopes
function populateScopeDropdown(data) {
  const scopeSet = new Set(data.map(row => row.scope));
  const scopeSelect = document.getElementById('scopeSelect');
  scopeSet.forEach(scope => {
    const option = document.createElement('option');
    option.value = scope;
    option.textContent = scope;
    scopeSelect.appendChild(option);
  });
}

function updateChart() {
	if (chartInstance) chartInstance.destroy();

	const daysBack = parseInt(document.getElementById('timePeriod').value);
	const selectedScope = document.getElementById('scopeSelect').value;
	const selectedMetric = document.getElementById('metricSelect').value;

	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - daysBack);

  // Filter by date
	const filteredData = allData.filter(row => {
		const rowDate = new Date(row.time);
		return rowDate >= cutoffDate;
	});
  
	updateStats(filteredData);
  
   // Filter by scope
	const filteredData2 = filteredData.filter(row => {
		const scopeMatch = (selectedScope === 'all') || (row.scope === selectedScope);
		return scopeMatch;
	});
	
	updateAdvancedStats(filteredData2);
	const change = getPeriodChange(allData, daysBack, selectedScope);
	document.getElementById('statPeriodChange').textContent = 
	  (change >= 0 ? '+' : '') + change.toFixed(1) + '%';

  // Group by date and sum the selected metric
  const grouped = {};
  filteredData2.forEach(row => {
    const date = row.time.slice(0, 10);
    grouped[date] = (grouped[date] || 0) + row[selectedMetric];
  });

  const labels = Object.keys(grouped).sort();
  const values = labels.map(label => grouped[label]);

  const ctx = document.getElementById('myChart').getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: selectedMetric === 'file_count' ? 'Files Imported' : 'Data Imported (MB)',
        data: values,
        backgroundColor: 'rgba(54, 162, 235, 0.5)'
      }]
    },
    options: {
      responsive: true,
	  maintainAspectRatio: false,
      scales: {
        x: { title: { display: true, text: 'Date' }, ticks: { autoSkip: true, maxTicksLimit: 10 } },
        y: { 
          title: { display: true, text: selectedMetric === 'file_count' ? 'Files Imported' : 'Data Imported (MB)' }, 
          beginAtZero: true 
        }
	  },
	  plugins:{
		  legend: {
			display: false
			}
	  }
	}
  });
}

document.getElementById("exportPageBtn").addEventListener("click", () => {
  const exportButton = document.getElementById("exportPageBtn");
  exportButton.style.display = "none"; // Hide the button before capture

  html2canvas(document.body).then(canvas => {
    const link = document.createElement("a");
    link.download = "dashboard.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
    exportButton.style.display = ""; // Show it again after export
  });
});

function updateStats(filteredData) {
  // Most used scope (file number)
  const scopeFiles = {};
  filteredData.forEach(row => {
    scopeFiles[row.scope] = (scopeFiles[row.scope] || 0) + row.file_count;
  });
  const topScopeFiles = Object.entries(scopeFiles).sort((a, b) => b[1] - a[1])[0];
  document.getElementById('statScopeFiles').textContent = topScopeFiles ? `${topScopeFiles[0]} (${topScopeFiles[1]})` : '-';

  // Most used scope (file size)
  const scopeSize = {};
  filteredData.forEach(row => {
    scopeSize[row.scope] = (scopeSize[row.scope] || 0) + row.total_file_size_mb;
  });
  const topScopeSize = Object.entries(scopeSize).sort((a, b) => b[1] - a[1])[0];
  document.getElementById('statScopeSize').textContent = topScopeSize ? `${topScopeSize[0]} (${topScopeSize[1].toFixed(2)} MB)` : '-';
}

function updateAdvancedStats(filteredData) {
	// Number of files imported
	const totalFiles = filteredData.reduce((sum, row) => sum + row.file_count, 0);
	document.getElementById('statFiles').textContent = totalFiles;

	// Total size imported
	const totalSize = filteredData.reduce((sum, row) => sum + row.total_file_size_mb, 0);
	document.getElementById('statSize').textContent = totalSize.toFixed(2);

	// Number of unique users
	const userSet = new Set(filteredData.map(row => row.username));
	document.getElementById('statUsers').textContent = userSet.size;	

	// Average import size (MB per import)
	const avgImportSize = filteredData.length
	? (filteredData.reduce((sum, row) => sum + row.total_file_size_mb, 0) / filteredData.length): 0;
	document.getElementById('statAvgImportSize').textContent = avgImportSize.toFixed(2);

	// Average import time per MB (seconds per MB)
	const totalTime = filteredData.reduce((sum, row) => sum + row.import_time_s, 0);
	const avgTimePerMB = totalSize ? (totalTime / totalSize) : 0;
	document.getElementById('statAvgTimePerMB').textContent = avgTimePerMB.toFixed(3);
	
	// Find the day with the highest number of files imported
	const dayCounts = {};
	filteredData.forEach(row => {
	  const date = row.time.slice(0, 10);
	  dayCounts[date] = (dayCounts[date] || 0) + row.file_count;
	});
	const peakDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
	document.getElementById('statPeakDay').textContent = peakDay ? `${peakDay[0]} (${peakDay[1]})` : '-';
}

function getPeriodChange(filteredData, daysBack, selectedScope) {
	const now = new Date();
	const periodStart = new Date(now);
	periodStart.setDate(now.getDate() - daysBack);
	const prevPeriodStart = new Date(periodStart);
	prevPeriodStart.setDate(periodStart.getDate() - daysBack);

	// Current period
	const current = filteredData.filter(row => {
		const rowDate = new Date(row.time);
		const scopeMatch = (selectedScope === 'all') || (row.scope === selectedScope);
		return rowDate >= periodStart && rowDate <= now && scopeMatch;
	});
	// Previous period
	const previous = filteredData.filter(row => {
		const rowDate = new Date(row.time);
		const scopeMatch = (selectedScope === 'all') || (row.scope === selectedScope);
		return rowDate >= prevPeriodStart && rowDate < periodStart && scopeMatch;
	});

	const currentSum = current.reduce((sum, row) => sum + row.file_count, 0);
	const previousSum = previous.reduce((sum, row) => sum + row.file_count, 0);

	// Percentage change
	let change = 0;
	if (previousSum === 0 && currentSum > 0) {
	change = 100;
	} else if (previousSum === 0 && currentSum === 0) {
	change = 0;
	} else {
	change = ((currentSum - previousSum) / previousSum) * 100;
	}
	return change;
}