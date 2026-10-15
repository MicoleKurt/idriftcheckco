# Releasing

Releases publish to npm from GitHub Actions with **trusted publishing**: no npm token is
stored anywhere, no passkey prompt per release, and every version carries a provenance
statement linking it to the exact commit and workflow run.

## One-time setup (maintainer, about two minutes)

1. On npmjs.com open the `idriftcheckco` package → **Settings** → **Trusted publishing**.
2. Add a GitHub Actions publisher:
   - Organization or user: `MicoleKurt`
   - Repository: `idriftcheckco`
   - Workflow filename: `release.yml`
   - Environment: `npm`
3. Optional, recommended: in the repository settings create the `npm` environment with
   required reviewers, so a release needs an explicit approval before it publishes.

Until this is done, the release workflow fails at the publish step with a 403/404, and
nothing is published.

## Each release

1. Bump `version` in `package.json` and `VERSION` in `src/version.ts` (a test keeps them
   in sync), and move the `CHANGELOG.md` entry out of "unreleased".
2. Commit, push, and wait for CI and the Action self-test to pass.
3. Create a GitHub Release with tag `vX.Y.Z` matching `package.json` (the workflow refuses
   a mismatched tag). Publishing the release triggers `.github/workflows/release.yml`,
   which runs the full check, builds, and publishes with provenance.
4. Move the floating Action tag: `git tag -f v0 vX.Y.Z && git push -f origin v0`.

## Manual fallback

If the workflow cannot be used, publish from a terminal you are present at (npm will ask
for a passkey or one-time code):

```bash
npm publish --access public
```
