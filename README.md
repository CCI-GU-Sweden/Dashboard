# CCI Import Dashboard

This is a simple dashboard made to display how much data and files are transiting through the CCI Upload app.

## Why

The CCI Upload app is used at the CCI, University of Gothenburg, to upload microscope images on an Omero server. This app can be found here [link](https://github.com/CCI-GU-Sweden/Omero_GU/tree/test/main), and can convert some Electron Microscope image format to Ome-Tiff, and extract some metadata to automatically tag and annotate images. When doing this, the app will also record usage (anonymously) in a postgreSQL database.

This dashboard read such usage and display simple statistics, such as the number of files imported, the average size and classify these by microscope and time period (Week, Month or Year).

This app is designed to be deployed on OpenShift and to setup some environment variables (connection credential to the postgreSQL).

## How

The backend is split into database, authentication middleware, and route modules. Its API is organized as follows:

- `/api/secure` is used to enter the shared password.
- `/api/summary` returns the overview period and one summary object per dashboard section. It currently includes upload count, total bytes, and the top microscope for the one-month period ending today.
- `/api/uploads/summary` returns upload statistics for the selected microscope, time period, and data type.
- `/api/uploads/history` returns the chart history for the same upload filters.
- `/api/uploads/scopes` and `/api/uploads/microscopes` return the available upload scopes (currently, a scope identifies a microscope).
- `/api/omero/summary`, `/history`, `/groups`, `/filesets`, `/policies`, and `/collector-runs` are authenticated placeholders for the OMERO dashboard and currently return `501 Not Implemented`.

The frontend opens on an overview of Uploads, OMERO Storage, and Compute. The Uploads card navigates to the dedicated `/uploads` page; detailed data is loaded only when that page is opened. Authentication is retained for that navigation in the current browser tab.

## Security

Access to the database is done by setting up the correct credentials in OpenShift.  
A shared password is require to allow the backend to connect to the database (password different from the database password).  
A jsonwebtoken (JWT) is monitoring the session with a token. Session duration is set to 1 hour.  
A rate limiter to 100 API calls every 15 min.  

## Next

- Currenlty only display last year/month/week of data. Can keep that but can also show more control:
    - Allow a range selection (calender style)
- Add 2 extra card: average size / time period and average file imported / time period
- Add some colour to the card?
- Correct the Metric (Data (MB)) to GB!
