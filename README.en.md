<p align="right"><a href="README.md">简体中文</a> · <strong>English</strong></p>

<p align="center">
  <img src="assets/readme/seal.svg" width="96" height="96" alt="Cadre Heihei seal">
</p>

<h1 align="center">Cadre Heihei</h1>

<h3 align="center">Stop being a project manager. Get back to creating.</h3>

<p align="center">Your supervisor breaks the idea down, dispatches the work, and reviews what comes back. Employees execute. You get the conclusion — not the busywork — and can change your mind anytime.</p>

<p align="center">
  <img src="assets/readme/badge-mit.svg" height="20" alt="MIT License">
  &nbsp;
  <img src="assets/readme/badge-windows.svg" height="20" alt="Windows 10 / 11">
  &nbsp;
  <img src="assets/readme/badge-preview.svg" height="20" alt="Preview">
</p>

<p align="center">
  <a href="https://github.com/KyuuKyuuStone/cadre-heihei/releases"><img src="assets/readme/cta-download-en.svg" width="200" height="48" alt="Download for Windows"></a>
  &nbsp;&nbsp;
  <a href="#from-idea-to-shipped">See how it works →</a>
</p>

<p align="center">
  <img src="assets/readme/00-hero.png" width="1200" alt="Cadre Heihei main window: the supervisor decomposes a cafe website request and dispatches tasks to a designer and a backend engineer; the sidebar shows who is running">
</p>
<p align="center"><sub>A real run: one request, decomposed and dispatched; the sidebar shows who is running.</sub></p>

## From idea to shipped

This is one continuous, real run — from an empty start to a delivered and reviewed cafe website. Every step happens in the supervisor conversation; no forms, boards, or workflow setup.

The app UI is currently Chinese-only; the screenshots show the Chinese interface as shipped.

### 01 Open and start

<p align="center">
  <img src="assets/readme/01-first-launch.png" width="820" alt="First launch: an empty state with the add-project entry point">
</p>
<p align="center"><sub>A clean first launch; “Add project” is the only entry point.</sub></p>

### 02 Create a project, build a team

<p align="center">
  <img src="assets/readme/02-project-team.png" width="820" alt="A project bound to a local folder, with a supervisor, designer, frontend, and backend already created; the conversation is empty">
</p>
<p align="center"><sub>One local folder is one project. Create a supervisor first, then add employees by role.</sub></p>

### 03 Tell the supervisor the idea

<p align="center">
  <img src="assets/readme/03-idea.png" width="820" alt="A cafe website request typed into the supervisor conversation but not yet sent; the team is visible in the sidebar">
</p>
<p align="center"><sub>No requirements document. State the goal in one sentence; change your mind whenever.</sub></p>

### 04 The supervisor decomposes and dispatches

<p align="center">
  <img src="assets/readme/04-dispatch.png" width="820" alt="The supervisor breaks the request into tasks with deadlines and assigns them to a designer and a backend engineer; employees are running in the sidebar">
</p>
<p align="center"><sub>The supervisor breaks the goal into tasks, sets deadlines, and assigns them by role.</sub></p>

### 05 Employees execute and report with deliverables

<p align="center">
  <img src="assets/readme/05-report.png" width="820" alt="A complete employee report card with a result summary and a deliverables list; the designer is still running">
</p>
<p align="center"><sub>Each employee works in a separate session. Report cards carry the result summary, deliverables, and test conclusions.</sub></p>

### 06 The supervisor reviews and gives you the verdict

<p align="center">
  <img src="assets/readme/06-acceptance.png" width="820" alt="The supervisor's final report after review, separating verified facts, unresolved items, and risks">
</p>
<p align="center"><sub>The supervisor checks deliverables against completion criteria and reports back as verified / unresolved / risk.</sub></p>

## You create; you don't have to be the project manager

- **Only decide** — no scheduling, task breakdown, or chasing status. If the idea changes, tell the supervisor.
- **See the work** — who is doing what and where it stands, in the sidebar and in employee report cards.
- **Check the delivery** — files, test results, and review notes live in the same project, not in a verbal summary.

Each project has exactly one supervisor — your only point of contact. Employees don't talk to each other; every task flows through the supervisor.

## Ready to hand the idea to a team?

<p align="center">
  <a href="https://github.com/KyuuKyuuStone/cadre-heihei/releases"><img src="assets/readme/cta-download-en.svg" width="200" height="48" alt="Download for Windows"></a>
</p>

- Windows 10 / 11 desktop; installer is about 274 MB and unsigned
- No account or sign-in; add your model provider's API key in Settings
- Data stays on your machine in `~/.dsh`; uninstalling does not delete it, and reinstalling keeps your team and history

<details>
<summary>Install, tech stack, and acknowledgments</summary>

### Install

1. Download the Windows installer from [GitHub Releases](https://github.com/KyuuKyuuStone/cadre-heihei/releases). It is not code-signed; SmartScreen may warn — choose “More info → Run anyway”.
2. Install and launch, then add your model provider's API key in Settings.
3. Create a project (pick a local folder), create a supervisor, then add employees as needed. Open the supervisor conversation and say what you want.

### Tech stack

- **Platform**: Windows desktop (Electron); the upstream web shell is outside this project's maintenance scope
- **Engine**: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT), a plugin-based architecture
- **Storage**: task ledger in SQLite (`~/.dsh/cadre.sqlite`), sessions as JSONL — all local
- **Upstream changes**: every change we made is recorded in [`desktop/UPSTREAM.md`](desktop/UPSTREAM.md)
- **License**: MIT for this project; [`LICENSE`](LICENSE) retains the original DeepSeek copyright notice
- **Predecessor**: [cc-heihei](https://github.com/KyuuKyuuStone/claude-code-heihei), frozen at v1.7.9

Thanks to the DeepSeek team for open-sourcing DeepSeek Harness — this project would not exist without that foundation.

</details>
