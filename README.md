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

The production page loads the consent-based LeadPilot tracker from the portfolio
Sites backend. It records page views, project and credential views, downloads,
contact actions, and referral/UTM context only after the visitor allows
analytics. Anonymous activity remains anonymous until the visitor submits the
enquiry form. Visitors can reopen their analytics preferences from the footer.

## LeadPilot inquiry delivery

The native enquiry form writes the consented lead to the private portfolio CRM:

```text
https://jayson-sugpatan-portfolio.jayrisse1490.chatgpt.site/crm
```

The owner-only workspace provides intent scoring, searchable leads, pipeline
stages, priorities, next actions, follow-up dates, and internal activity notes.
The same form also sends a non-blocking secondary copy to the existing n8n
intake for HubSpot synchronization:

```text
https://jaysonsugpatan1490.app.n8n.cloud/webhook/leadpilot-inbound
```

The H7 inbound workflow can continue normalizing and routing that copy to the
LeadPilot HubSpot portal. A HubSpot or n8n interruption does not prevent the
primary private-CRM record from being saved.

The website captures acquisition context including the page URL, referrer, UTM
parameters, source detail, and submission timestamp. It also includes client
validation, a honeypot field, request timeout/error handling, and a direct-email
fallback. No HubSpot private token or n8n credential is stored in the public
GitHub Pages bundle.

Identifiable details enter the CRM only after the visitor submits the form and
accepts its disclosure. No private CRM, HubSpot, or n8n credential is stored in
the public GitHub Pages bundle.
