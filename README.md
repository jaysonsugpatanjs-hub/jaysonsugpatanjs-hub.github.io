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

## GitHub Pages release

```bash
npm run build:pages
```

GitHub Pages serves the committed production files at the repository root. The
release command builds from source and synchronizes the generated `index.html`,
hashed `assets/`, and public files to that location.

H8.1 adds `.github/workflows/build-pages.yml` so this synchronization is
automatic. Pull requests that affect the site run the production build as a
validation check. After qualifying source/configuration changes reach `main`,
GitHub Actions runs `npm ci` and `npm run build:pages`, verifies the output, and
commits changed generated root files back to `main`. The generated-only commit
uses `[skip ci]`, and the workflow's path filters exclude generated assets, so it
does not create a deployment loop.

## Visitor analytics

The production page loads the Simple Analytics light script. It records
anonymous page views and a small set of conversion events such as portfolio
downloads, contact-link clicks, contact-section opens, and successful inquiry
submissions. The provider does not record localhost visits.

Add `jaysonsugpatanjs-hub.github.io` to a Simple Analytics dashboard to view the
data. The integration uses the hostname, so no public API key or repository
secret is required.

## LeadPilot inquiry delivery

H8 replaces the visible legacy HubSpot embed with a native LeadPilot inquiry
form. The browser sends the inquiry to the production n8n endpoint:

```text
https://jaysonsugpatan1490.app.n8n.cloud/webhook/leadpilot-inbound
```

The H7 inbound workflow normalizes and validates the submission, applies the
current LeadPilot qualification rules, and forwards a canonical lead to the
MAIN CRM workflow. MAIN CRM then creates or reuses the appropriate Company,
Contact, Deal, and follow-up Task in the LeadPilot HubSpot portal according to
the routing rules.

The website captures acquisition context including the page URL, referrer, UTM
parameters, source detail, and submission timestamp. It also includes client
validation, a honeypot field, request timeout/error handling, and a direct-email
fallback. No HubSpot private token or n8n credential is stored in the public
GitHub Pages bundle.

Anonymous visits remain in Simple Analytics. Identifiable details enter the CRM
only after a visitor submits the inquiry form and are covered by the privacy
notice displayed with the form.
