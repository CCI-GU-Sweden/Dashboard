# CCI Import Dashboard

This is a simple dashboard made to display how much data and files are transiting through the CCI Upload app.

## Why

The CCI Upload app is used at the CCI, University of Gothenburg, to upload microscope images on an Omero server. This app can be found here [link](https://github.com/CCI-GU-Sweden/Omero_GU/tree/test/main), and can convert some Electron Microscope image format to Ome-Tiff, and extract some metadata to automatically tag and annotate images. When doing this, the app will also record usage (anonymously) in a postgreSQL database.

This dashboard read such usage and display simple statistics, such as the number of files imported, the average size and classify these by microscope and time period (Week, Month or Year).

This app is designed to be deployed on OpenShift and to setup some environment variables (connection credential to the postgreSQL).

## How

The backend is split into database, authentication middleware, and route modules. Its API is organized as follows:

- `/api/secure` is used to enter the shared password.
- `/api/summary` returns the Uploads overview plus the latest OMERO fileset count, total storage, and daily billable SEK, with changes from the closest snapshot at least one month earlier.
- `/api/uploads/summary` returns upload statistics for the selected microscope, time period, and data type.
- `/api/uploads/history` returns the chart history for the same upload filters.
- `/api/uploads/scopes` and `/api/uploads/microscopes` return the available upload scopes (currently, a scope identifies a microscope).
- `/api/omero/history` returns total and billable daily storage from `group_storage_snapshot`, in either decimal GB or öre per day.
- `/api/omero/groups` returns the OMERO groups available in the snapshot history.
- `/api/omero/summary` returns seven latest-snapshot metrics and their changes from the selected comparison date.
- `/api/omero/filesets`, `/policies`, and `/collector-runs` remain authenticated placeholders and currently return `501 Not Implemented`.

The frontend opens on an overview of Uploads, OMERO Storage, and Compute. Each card opens its own mutually exclusive dashboard view while keeping the shared university header and login control visible. Upload details are loaded only when the Uploads view is opened, and authentication is retained in the current browser tab.

The OMERO Storage view graphs the daily total and billable series. In storage mode, values use decimal GB (`1 GB = 1,000,000,000 bytes`) to match collector billing. In öre mode, Total is the daily charge if all stored bytes were billable at each snapshot's applied rate, while Billable uses the stored `daily_charge_ore` value.

The dashboard reads these tables through its existing statistics-database `PG*` connection. That PostgreSQL role needs `SELECT` on `public.group_storage_snapshot`. Do not use `omero-stats-reader-secret` here: that credential reads the source OMERO database, while the snapshot table belongs to `omerofilestats`.

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
