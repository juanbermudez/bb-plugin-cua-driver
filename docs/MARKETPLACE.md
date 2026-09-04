# Marketplace submission

Target: <https://github.com/get-bb/marketplace> (`bb-community`), entry file
`entries/cua-driver.json`, category `agents-and-providers`.

Everything below is prepared in `../marketplace-submission/` at the workspace
root (entry, vendored icon `icons/cua-driver-122e4a7b.svg` named with the
first 8 hex chars of the SVG's SHA-256, PR body). Nothing has been pushed.

## Listing copy

**Display name:** Computer Use

**Description (one sentence, marketplace):** Gives bb agents background
desktop and Chromium browser control, powered by the open-source Cua Driver
from Cua AI, with per-provider routing.

**Tags:** computer-use, desktop-automation, browser, agent-tools, cua, mcp,
multi-machine, providers

**Long description (README / store detail):**

> Computer Use turns any bb thread into a desktop operator. Agents
> snapshot a window's accessibility tree plus screenshot, act on elements by
> token without stealing your focus, verify the result, and escalate to pixel
> or foreground delivery only on a real signal. Chrome, Edge, and Electron
> windows get typed page tools; the clipboard and the full upstream catalog
> are one call away. Choose per provider: keep Codex on its own computer use,
> give Claude Code and Pi Cua Driver, or use Cua everywhere. Works on every
> enrolled bb machine that has Cua Driver installed, including remote ones.

## Release checklist (before the PR)

1. Create the public repo `juanbermudez/bb-plugin-cua-driver`, push `main`.
2. Set `package.json` version `0.1.0`, `CHANGELOG.md` dated, run
   `npm run check`, commit.
3. Annotated tag and push:
   ```sh
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin HEAD && git push origin v0.1.0
   git ls-remote --tags https://github.com/juanbermudez/bb-plugin-cua-driver.git
   ```
4. Screenshots (optional but recommended): PNG/JPEG/WebP, ≥1200 px wide,
   ≤2 MiB, into `marketplace-submission/screenshots/cua-driver/` and list them
   in the entry as `./screenshots/cua-driver/<file>` (max 6). Suggested:
   settings page, a Claude Code thread driving Calculator with the screenshot
   row expanded, `bb cua status` output.
5. Confirm `author.github` matches the account opening the PR (`gh api user
   --jq .login`).

## Submit

```sh
gh repo fork get-bb/marketplace --clone=false
git clone https://github.com/<login>/marketplace.git /tmp/bb-marketplace
cd /tmp/bb-marketplace
git remote add upstream https://github.com/get-bb/marketplace.git
git fetch upstream main && git switch -c submit-cua-driver upstream/main
cp <workspace>/marketplace-submission/entries/cua-driver.json entries/
cp <workspace>/marketplace-submission/icons/cua-driver-122e4a7b.svg icons/
# optional screenshots → screenshots/cua-driver/
npm ci --ignore-scripts && npm run build && npm test && npm run gate:v1 && npm run check
git add entries/cua-driver.json icons/cua-driver-122e4a7b.svg screenshots/cua-driver
git commit -m "Add plugin entry: cua-driver"
git push -u origin submit-cua-driver
gh pr create --repo get-bb/marketplace --base main --head <login>:submit-cua-driver \
  --title "Add plugin entry: cua-driver" --body-file <workspace>/marketplace-submission/pr-body.md
```

`npm run check` in the marketplace repo verifies the Git source is public and
the range resolves to a tag, so steps 1–3 must be done first.

## Cua attribution and outreach

- `NOTICE.md` credits Cua AI, Inc., the MIT license, the logo origin, and the
  skill derivation.
- The product-facing display name is **Computer Use**. The listing, README,
  settings About card, and notice identify Cua Driver as the underlying runtime
  and link to Cua's official documentation and source.
- Suggested note to Cua after publishing: link to the repo and the marketplace
  entry, point to `docs/SPEC.md` §11 (open questions), and offer
  co-maintenance.
