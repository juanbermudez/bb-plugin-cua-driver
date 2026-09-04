# Third-party notices

## Cua Driver (Cua AI, Inc.)

This plugin is an independent integration for [bb](https://getbb.app) that
drives the **Cua Driver** runtime. It is not affiliated with or endorsed by
Cua AI, Inc.

- Cua Driver, the `cua-driver` CLI, the MCP server, and the SDKs are developed
  by Cua AI, Inc. and released under the MIT License:
  <https://github.com/trycua/cua> (see `LICENSE.md` in that repository).
- The plugin logo in `icons/cua.svg` is derived from `img/logo_black.svg` in
  the Cua repository (MIT). "Cua" is a name of Cua AI, Inc.; it is used here
  only to identify the upstream runtime this plugin integrates.
- The agent skill in `skills/cua-computer-use/SKILL.md` is adapted from the
  upstream Cua Driver skill pack (`libs/cua-driver/rust/Skills/cua-driver/`,
  MIT). Sections on the snapshot-before-action invariant, the
  verify-then-escalate ladder, and the pitfalls list are condensed from that
  source and adjusted to bb's tool names.

The plugin never bundles Cua Driver binaries. Users install Cua Driver
separately from <https://cua.ai/docs/how-to-guides/driver/install>.

Apple, macOS, Microsoft, Windows, and Linux are trademarks of their respective
owners.
