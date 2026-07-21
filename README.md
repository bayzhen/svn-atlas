# SVN Atlas

SVN Atlas is a local-first Subversion workspace for Visual Studio Code.

## Current release: local BASE Quick Diff

The first release deliberately focuses on one thing: showing local SVN changes in the editor gutter without scanning an entire checkout or contacting the repository server.

- Compares an open file's `WORKING` content with its local SVN `BASE`.
- Uses `svn cat -r BASE`, so normal gutter refreshes do not compare against remote `HEAD`.
- Does not execute recursive `svn status`, `svn status -u`, history, blame, or remote polling.
- Caches only a bounded set of open-file base contents.
- Watches the working-copy database and refreshes open files after an SVN update. `SVN Atlas: Refresh Local Base` is available as a manual fallback.

The usual VS Code source-control decoration settings control visibility:

```json
{
  "scm.diffDecorations": "gutter",
  "scm.diffDecorationsGutterVisibility": "always"
}
```

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `svnAtlas.executablePath` | `svn` | Path to the Subversion executable. |
| `svnAtlas.quickDiff.enabled` | `true` | Enables local BASE gutter decorations. |
| `svnAtlas.quickDiff.cacheSize` | `128` | Maximum cached open-file BASE contents. |
| `svnAtlas.quickDiff.maxCacheSizeMB` | `64` | Maximum combined size of cached BASE contents. |
| `svnAtlas.quickDiff.maxFileSizeMB` | `16` | Skips larger files; use `0` to disable the limit. |

## Roadmap

SVN Atlas is intentionally starting narrow, not staying narrow. The architecture keeps the SVN command boundary separate from the VS Code integration so future capabilities can be added without reintroducing full-workspace work into the editor path:

- lightweight pending-change view;
- update, commit, revert, add, delete, and conflict workflows;
- history, blame, properties, changelists, locks, and externals;
- configurable remote checks that remain disabled by default.

## Development

```powershell
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host, open an SVN working copy, edit and save a versioned text file, and confirm the gutter markers appear.

## License

[MIT](LICENSE)
