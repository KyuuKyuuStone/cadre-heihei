<p align="right"><a href="README.md">简体中文</a> · <strong>English</strong></p>

<p align="center">
  <img src="assets/readme/seal.svg" width="112" height="112" alt="Cadre Heihei seal">
</p>

<h1 align="center">Cadre Heihei</h1>

<p align="center">Tell your supervisor what you want. It breaks the work down, dispatches employees, and reviews what comes back — you only make decisions.</p>

<p align="center">
  <img src="assets/readme/badge-mit.svg" height="20" alt="MIT License">
  &nbsp;
  <img src="assets/readme/badge-windows.svg" height="20" alt="Windows 10 / 11">
  &nbsp;
  <img src="assets/readme/badge-preview.svg" height="20" alt="Preview">
</p>

<p align="center">
  <a href="#how-it-works">How it works</a> ·
  <a href="#features">Features</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a>
</p>

---

<p align="center">
  <img src="assets/readme/01-main-window.png" alt="Cadre Heihei main window: projects and team on the left, supervisor conversation on the right" width="1200">
</p>
<p align="center"><sub>Main window: projects and team on the left; the supervisor decomposing a request, dispatching work, and receiving an employee report on the right.</sub></p>

## How it works

You don't write a requirements document, and you don't configure a workflow. Everything happens in one conversation.

| Step | Who | What happens |
|:---|:---|:---|
| 1 | You | Say what you want; change your mind whenever |
| 2 | Supervisor | Understands the goal, breaks it into executable tasks, and dispatches by role |
| 3 | Employee → Supervisor | The employee executes and delivers; the supervisor verifies against the deliverable and reports back to you |

Each project has exactly one supervisor — your only point of contact. Employees don't talk to each other; every task flows through the supervisor.

## Features

<table>
<tr>
<td width="50%" valign="top"><strong>The conversation is the control surface</strong><br>No forms, boards, or setup wizards. State the goal, change your mind, or ask for status — all in the same conversation.</td>
<td width="50%" valign="top"><strong>A project is an isolation boundary</strong><br>One local folder is one project. People, tasks, and context in different projects are invisible to each other.</td>
</tr>
<tr>
<td valign="top"><strong>Role-based employees</strong><br>The supervisor dispatches but does not do the work; employees execute without guessing intent. Each employee is a separate session and handles one thing at a time.</td>
<td valign="top"><strong>Task ledger and two-layer reporting</strong><br>The roster, task states, and handoffs live in local SQLite. Employees report to the supervisor; the supervisor verifies, then reports to you as verified / unresolved / risk.</td>
</tr>
</table>

## Screenshots

The app UI is currently Chinese-only; the screenshots show the Chinese interface as shipped.

<p align="center">
  <img src="assets/readme/02-supervisor-conversation.png" alt="Supervisor conversation: request, dispatch, and employee report card" width="900">
</p>
<p align="center"><sub>The supervisor conversation: one request → decomposition and dispatch → employee report card. A real run, not a mock.</sub></p>

<p align="center">
  <img src="assets/readme/03-team-sidebar.png" alt="Team sidebar: pinned supervisor and three employees with roles and status" width="360">
</p>
<p align="center"><sub>The team sidebar: the supervisor is pinned; each employee shows their role, status, and current task.</sub></p>

## Install

**Download**: [GitHub Releases v0.8.7](https://github.com/KyuuKyuuStone/cadre-heihei/releases/tag/v0.8.7) — Windows installer (about 274 MB, unsigned)

<p align="center">
  <img src="assets/readme/04-installer.png" alt="Windows installer: seal, wordmark, and primary button" width="600">
</p>
<p align="center"><sub>The Windows installer: install-location page with the seal, wordmark, and primary action in one view.</sub></p>

- **OS**: Windows 10 / 11 only (desktop)
- **Signing**: the installer is not code-signed; SmartScreen may warn — choose "More info → Run anyway"
- **Account**: none. Add your own model provider API key in Settings
- **Data**: stays on your machine in `~/.dsh`; uninstalling does not delete it, and reinstalling keeps your team and history
- **Auto-update and telemetry**: off by default

## Quick start

1. Install and launch the app; add your model provider API key in Settings.
2. Create a project (pick a local folder), create a supervisor, then add employees as needed (role templates are available).
3. Open the supervisor conversation and say what you want. Decomposition, dispatch, follow-up, and review are handled for you.

<details>
<summary>Tech stack, acknowledgments, and license</summary>

- **Platform**: Windows desktop (Electron); the upstream web shell is outside this project's maintenance scope
- **Engine**: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT), a plugin-based architecture
- **Storage**: task ledger in SQLite (`~/.dsh/cadre.sqlite`), sessions as JSONL — all local
- **Upstream changes**: every change we made is recorded in [`desktop/UPSTREAM.md`](desktop/UPSTREAM.md)
- **License**: MIT for this project; [`LICENSE`](LICENSE) retains the original DeepSeek copyright notice
- **Predecessor**: [cc-heihei](https://github.com/KyuuKyuuStone/claude-code-heihei), frozen at v1.7.9

Thanks to the DeepSeek team for open-sourcing DeepSeek Harness — this project would not exist without that foundation.

</details>
