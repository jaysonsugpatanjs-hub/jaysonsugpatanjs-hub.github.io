# Jayson P. Sugpatan — Professional Portfolio

Employer-facing portfolio connecting industrial engineering, operations improvement, data analysis, workflow design, and hands-on fabrication experience.

## Live site

The portfolio is configured for GitHub Pages at:

https://jaysonsugpatanjs-hub.github.io

## Local development

```bash
npm ci
npm run dev
```

## Production build

```bash
npm run build
```

Vite reads `src/index.html` and the React source, then writes a clean build to
`dist/`.

## Prepare a GitHub Pages release

```bash
npm run build:pages
```

GitHub Pages currently serves the committed files at the repository root. The
release command builds from source and synchronizes the generated `index.html`,
hashed `assets/`, and public files to that location. Commit those generated
changes with the source changes before pushing to `main`.

## Visitor analytics

The production page loads the 1.9 KB compressed Simple Analytics light script.
It records anonymous page views and a small set of conversion events: portfolio
downloads, contact-link clicks, contact-section opens, and successful inquiry
submissions. The provider does not record localhost visits.

Add `jaysonsugpatanjs-hub.github.io` to a Simple Analytics dashboard to view the
data. The integration uses the hostname, so no public API key or repository
secret is required.

## Inquiry delivery

The contact form sends to `jayson.sugpatan.js@gmail.com` through FormSubmit's
static-site AJAX endpoint and falls back to a pre-filled email when delivery
fails. FormSubmit requires a one-time email confirmation after the first test
submission. Confirm that message before treating the form as live.
