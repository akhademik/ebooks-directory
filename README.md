# Ebook Manager

A minimalist, high-performance personal digital library manager designed to run on your local NAS. It seamlessly syncs local ebook files (PDF, EPUB, MOBI, AZW, AZW3) with a Google Sheets database and enriches metadata using a stealth Puppeteer scraper for Goodreads.

## Features

- **Blazing Fast UI**: Tabular layout with infinite scrolling (lazy loading). Displays only what you need, ensuring UI smoothness even with tens of thousands of books.
- **Smart Incremental Sync**: Instantly detects new files or deleted files on your NAS and updates the Google Sheet automatically. No duplicates, thanks to macOS NFC/NFD Unicode normalization fixes.
- **Background Metadata Enrichment**: A background worker intelligently scrapes Goodreads (bypassing bot detection) to fetch cover images, publication years, exact authors, and detailed rating statistics (e.g., `4.05 (83.5k)`).
- **On-the-fly Preview**: Click the eye icon to instantly generate a 5-page preview for PDF or EPUB files. Content is extracted and streamed directly to the UI without saving temporary files to disk.
- **Zero Local Database**: Uses a single Google Sheet as the source of truth. Lightweight and easily editable from anywhere.
- **Manual Override**: Add a specific `Goodreads ID` to the Sheet, and the system will explicitly fetch metadata for that specific edition.

## Tech Stack

- **Backend**: Node.js, Express, Puppeteer (with Stealth Plugin), Google APIs.
- **Frontend**: Vanilla JavaScript, TailwindCSS, FontAwesome.
- **Infrastructure**: Designed for Docker/Proxmox deployment.

## Setup & Deployment (Docker)

The recommended way to deploy this application is via Docker to ensure Puppeteer and its Chromium dependencies run perfectly without polluting your host OS.

### Prerequisites

1.  **Google Service Account**:
    - Create a Service Account in Google Cloud Console.
    - Enable the **Google Sheets API**.
    - Download the JSON credentials file.
2.  **Google Sheet**:
    - Create a blank Google Sheet.
    - Share the Sheet with the email address of your Google Service Account (give it Editor access).
    - Note the `Spreadsheet ID` from the URL.

### Configuration

Create a `.env` file in the root directory with the following structure:

```env
PORT=3000
BOOKS_PATH=/books
GOOGLE_SHEET_ID=your_spreadsheet_id_here
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_LONG_KEY_HERE\n-----END PRIVATE KEY-----\n"
```
*(Note: Ensure the private key retains the exact formatting, including the `\n` characters and quotes).*

### Docker Deployment

To run this on Proxmox or any Docker environment, you will need a `Dockerfile` and a `docker-compose.yml`.

**(Note: The Dockerfiles are not included in the core repository yet, but you can create them based on standard Node.js + Puppeteer configurations).**

Typical `docker-compose.yml` mapping:
```yaml
volumes:
  - ./.env:/app/.env
  - /path/to/your/nas/ebooks:/books # Map your physical NAS folder here
```

## Development

To run locally without Docker (requires Chrome/Chromium installed on your host):

1. `cd backend`
2. `npm install`
3. `cd ..`
4. `node backend/server.js`

Visit `http://localhost:3000`.

## Architecture Note

This project purposefully avoids a local SQL/NoSQL database to keep the Docker image strictly stateless and the footprint minimal. All data persistence relies on your Google Sheet, while the backend serves as an intelligent synchronization and scraping engine.
