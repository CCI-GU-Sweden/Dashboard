Frontend:
Open miniforge, then enter the following commands:
conda activate dashboard-test
cd /d D:\DATA\Simon\CCI\dashboard_test
python -m http.server 8000

Then open brave:
http://localhost:8000/index.html

For the Backend:
Should be already created:
	- mkdir dashboard-backend
	- cd dashboard-backend
	- npm init -y
	- npm install express pg

Start the backend:
node index.js

See the backend (json):
http://localhost:3000/imports
