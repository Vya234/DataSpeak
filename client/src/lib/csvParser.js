/**
 * CSV files are parsed on the **server** (see `server/src/services/csvService.js` and upload route).
 * The browser only sends the file as multipart form data.
 */
export const CSV_PARSE_SERVER_SIDE = true;
