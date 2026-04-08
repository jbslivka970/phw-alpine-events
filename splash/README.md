# PHW Splash Site

Standalone marketing splash site for `www.phwcoloradoalpine.org`.

## What is in this folder

- `index.html`: standalone landing page (no build step)
- `web.config`: IIS / Azure App Service rewrite and security headers
- `staticwebapp.config.json`: Azure Static Web Apps fallback + headers
- `CNAME`: custom domain file for GitHub Pages fallback
- `.nojekyll`: disables Jekyll processing in GitHub Pages

## Deployment Workflows

- `.github/workflows/splash-validate.yml`: validates and smoke-tests splash page changes
- `.github/workflows/splash-deploy-azure-webapp.yml`: deploys folder zip to Azure Web App
- `.github/workflows/splash-deploy-pages.yml`: deploys folder to GitHub Pages
- `.github/workflows/splash-smoke.yml`: scheduled/manual runtime smoke checks against live URL

## Azure App Service (recommended)

1. Create a dedicated Azure Web App for the splash site (separate from API app).
2. In GitHub repository settings, add variable:
   - `AZURE_SPLASH_WEBAPP_NAME`
3. In GitHub repository settings, add secret:
   - `AZURE_SPLASH_PUBLISH_PROFILE`
4. Push changes to `main` under `splash/**` or run workflow dispatch for:
   - `.github/workflows/splash-deploy-azure-webapp.yml`

### Namecheap DNS for Azure hosting

In Namecheap Advanced DNS:

1. Add `CNAME`:
   - Host: `www`
   - Value: `<your-azure-splash-webapp>.azurewebsites.net`
2. Add URL redirect for apex root:
   - Type: `URL Redirect Record`
   - Host: `@`
   - Value: `https://www.phwcoloradoalpine.org`
   - Redirect: `Permanent (301)`

Then add custom domain `www.phwcoloradoalpine.org` in the Azure Web App portal and bind a managed TLS certificate.

## GitHub Pages (fallback option)

1. In repository Settings, set Pages source to **GitHub Actions**.
2. Ensure your DNS has:
   - `CNAME` record: `www` -> `<org-or-user>.github.io`
3. Push to `main` with changes in `splash/**` or run the workflow manually.
4. In Pages settings, verify the custom domain is `www.phwcoloradoalpine.org`.
5. Enable "Enforce HTTPS" once DNS is verified.

Use this only if you do not want Azure hosting.

## Local preview

From repository root:

```bash
python3 -m http.server 4173 --directory splash
```

Then open `http://127.0.0.1:4173`.

## Functional smoke test

Run on demand from repo root:

```bash
./scripts/splash-smoke.sh https://www.phwcoloradoalpine.org
```

Or omit the URL and set `SPLASH_BASE_URL`.

CI smoke job:

- Workflow: `.github/workflows/splash-smoke.yml`
- Triggers: manual dispatch, daily schedule, and splash-related pushes
- Manual URL override: workflow dispatch input `base_url`

## Future extension pattern

As the splash site grows, keep assets and pages in this folder and continue shipping independently from backend/frontend app pipelines.
