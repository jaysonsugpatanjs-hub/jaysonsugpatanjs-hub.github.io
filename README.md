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

The employer and client inquiry form is connected to HubSpot portal
`247233549`, form `afd02813-0d3b-4d0f-a069-430518298b4c`, using HubSpot's
external form embed. Valid submissions create or update CRM contacts without
placing a private API key in the GitHub Pages bundle. The external form script
is lazy-loaded as the contact section approaches the viewport.

The page listens for HubSpot's updated form success and failure events so
confirmed inquiries remain measurable in Simple Analytics. If the external
form is blocked or takes too long to load, visitors are directed to the existing
email contact path instead.

Anonymous visits remain in Simple Analytics. Identifiable details are stored in
HubSpot only after a visitor submits the inquiry form and are covered by the
privacy notice displayed with the form.
