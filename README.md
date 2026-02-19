# CCI Import Dashboard

This is a simple dashboard made to display how much data and files are transiting through the CCI Upload app.

## Why

The CCI Upload app is used at the CCI, University of Gothenburg, to upload microscope images on an Omero server. This app can be found here [link](https://github.com/CCI-GU-Sweden/Omero_GU/tree/test/main), and can convert some Electron Microscope image format to Ome-Tiff, and extract some metadata to automatically tag and annotate images. When doing this, the app will also record usage (anonymously) in a postgreSQL database.

This dashboard read such usage and display simple statistics, such as the number of files imported, the average size and classify these by microscope and time period (Week, Month or Year).

This app is designed to be deployed on OpenShift and to setup some environment variables (connection credential to the postgreSQL).

## How

On the backend of this app (index.js) is a simple API:  
- secure is used to enter the shared password
- scope is used to get the list of microscope
- stats will grab the datapoints and statistics for the microscope, time period and data type

The frontend (index.html) is only used to display the data, and cannot be used to access the data.

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
