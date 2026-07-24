# Brainbook Development

## Build Windows with a Local AionCore

By default, `bun run build-win` downloads the configured AionCore release. To package local backend changes and their embedded assets, install AionCore and explicitly select that binary for the build:

```powershell
# Run from the AionCore repository.
cargo install --path crates/aionui-app --locked --force

# Run from the AionUi repository in the same PowerShell session.
$env:AIONUI_BACKEND_LOCAL_BINARY = "$HOME\.cargo\bin\aioncore.exe"
bun run build-win
```

After preparation, `resources/bundled-aioncore/win32-x64/manifest.json` should contain `"sourceType": "local-binary"`. If the variable is not set, the build continues to use the configured release binary.

## Sync with the Parent Repository

The expected remotes are:

- `origin`: the Brainbook fork
- `upstream`: `https://github.com/iOfficeAI/AionUi.git`

Confirm them before syncing:

```powershell
git remote -v
```

If `upstream` is missing, add it once:

```powershell
git remote add upstream https://github.com/iOfficeAI/AionUi.git
```

Commit local changes before rebasing, then replay the Brainbook commits on the latest parent branch:

```powershell
git status
git add <changed-files>
git commit -m "<type>: <description>"

git fetch upstream --prune
git rebase upstream/main
```

If the rebase reports conflicts, resolve each file and continue:

```powershell
git status
git add <resolved-files>
git rebase --continue
```

To cancel an incomplete rebase and return to the previous state:

```powershell
git rebase --abort
```

After a successful rebase, update the Brainbook fork:

```powershell
git push --force-with-lease origin main
```

Use `--force-with-lease`, not `--force`, because rebasing changes commit IDs while the lease protects unexpected remote changes.
