# Distribution Snapshots

This directory contains reviewed portable assets used by the Dark Factory
execution chain.

| Source              | Installed destination  |
| ------------------- | ---------------------- |
| `archon-workflows/` | `~/.archon/workflows/` |
| `archon-scripts/`   | `~/.archon/scripts/`   |
| `skills/`           | `~/.agents/skills/`    |

`manifest.json` maps every asset group to its destination and locks its file
contents and executable modes with a SHA-256 tree checksum. The repository-local
`ao-plugins/` directory is also checksummed but is not copied during setup.

The installed locations remain the development source of truth. After changing
an installed asset, replace its complete snapshot here and run:

```bash
node scripts/manage-distribution.mjs refresh-manifest
node scripts/manage-distribution.mjs verify-source
```

The active workflow chain is:

```text
auto-feature -> auto-merge -> auto-squash -> merge-gate
```

Third-party tools and plugins are not copied here. See `../docs/dependencies.md` and
`../dependencies.lock.json`.
