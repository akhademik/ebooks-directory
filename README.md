# Ebook Manager

A minimalist, high-performance personal digital library manager designed to run on your local NAS. It seamlessly syncs local ebook files (PDF, EPUB, MOBI, AZW, AZW3) with a Google Sheets database and enriches metadata using a stealth Puppeteer scraper for Goodreads.

## Features

- **Jitter-Free UI**: Advanced "Smart DOM Sync" ensures a perfectly smooth experience. The UI surgically updates only what's changed, preventing page jumps and cover flickering during background data fetches.
- **Blazing Fast Navigation**:
  - **Infinite Scrolling**: Lazy loading for thousands of books.
  - **Jump to Top**: Floating action button for quick navigation.
  - **Stat Chips**: Instant quick-filtering by book format (PDF, EPUB, etc.).
- **Smart Incremental Sync**: Instantly detects new files or deleted files on your NAS and updates the Google Sheet automatically. Includes robust fixes for macOS NFC/NFD Unicode normalization issues.
- **Background Metadata Enrichment**: Multi-worker background system that intelligently scrapes Goodreads (bypassing bot detection) to fetch cover images, publication years, exact authors, and detailed rating statistics (e.g., `4.05 (83.5k)`).
- **On-the-fly Preview**: Instant 5-page preview for PDF or EPUB files. Content is extracted and streamed directly to the UI without temporary files.
- **Zero Local Database**: Uses Google Sheets as the source of truth—stateless, lightweight, and editable from anywhere.
- **Manual Override**: Tag books for explicit metadata fetching using a specific `Goodreads ID` in the Sheet.

## Tech Stack

- **Backend**: Node.js, Express, Puppeteer (Stealth), Google APIs.
- **Frontend**: Vanilla JavaScript (Modern ES6+), TailwindCSS, CSS Variables.
- **Standards**: Strictly follows [Clean Code Rules](clean-code-rules.md).

## Setup & Deployment (Docker)

The recommended way to deploy is via Docker to ensure Puppeteer and its Chromium dependencies are isolated.

### Prerequisites

1.  **Google Service Account**:
    - Create a Service Account in [Google Cloud Console](https://console.cloud.google.com/).
    - Enable **Google Sheets API**.
    - Download the JSON credentials file.
2.  **Google Sheet**:
    - Create a blank Google Sheet.
    - Share the Sheet with the Service Account email (Editor access).
    - Copy the `Spreadsheet ID` from the URL.

### Configuration

Create a `.env` file in the root directory:

```env
PORT=3000
BOOKS_PATH=/books
GOOGLE_SHEET_ID=your_spreadsheet_id_here
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_LONG_KEY_HERE\n-----END PRIVATE KEY-----\n"
```

### Docker Deployment

Typical `docker-compose.yml` mapping:
```yaml
volumes:
  - ./.env:/app/.env
  - /path/to/your/nas/ebooks:/books
```

## Development & Maintenance

This project enforces strict code quality standards via ESLint.

### Commands

- **Start Backend**: `cd backend && npm install && node server.js`
- **Linting**: `npm run lint` (Must pass with 0 errors before any commit)
- **Auto-fix Lint**: `npm run lint -- --fix`
- **Sync Test**: `npm test` (Runs a dry-run sync check)

## Architecture Note

This project is purposefully stateless. All persistence relies on your Google Sheet, while the backend serves as an intelligent synchronization and scraping engine. UI state is managed through a lightweight vanilla JS architecture designed for performance and zero jitter.
