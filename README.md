<<<<<<< HEAD
# TypeSet
Opensource Latex based editor
=======
# Typeset

A free, local LaTeX desktop workspace: edit source files, compile with TeX Live, and read the PDF beside your document. Save named versions with Git, push them to GitHub, or back up project snapshots to Google Drive.

Typeset is a single-user app targeting macOS, Windows, and Linux. The interface runs in its own desktop window. Podman runs the compiler; Docker is not required. There is no hosted compilation service, subscription, or paid software dependency. GitHub and Google Drive are optional services used through their free allowances; they are not open-source services.

## Use the built Mac app

The verified Apple Silicon build is at `release/mac-arm64/Typeset.app`. Open it directly, or copy it to your Applications folder. The packaged app does not require Node.js or pnpm; it still uses Podman for compilation and Git for version history. On this development machine, the compiler image has already been built.

The Mac app uses free local ad-hoc signing and is not Apple-notarized. Its complete desktop workflow and code signature have been verified. GitHub and Google Drive require your own authentication setup below. Windows and Linux packages are configured but have not been built or tested on those operating systems.

## Start locally

Install these free prerequisites:

| Tool                                                      | Used for                                                |
| --------------------------------------------------------- | ------------------------------------------------------- |
| [Node.js](https://nodejs.org/en/download), 22.12 or newer | Building and running the development app                |
| [pnpm](https://pnpm.io/installation)                      | Installing JavaScript dependencies and running commands |
| [Git](https://git-scm.com/downloads)                      | Local version history and GitHub synchronization        |
| [Podman](https://podman.io/docs/installation)             | Running the LaTeX compiler                              |

On macOS and Windows, Podman uses a Linux virtual machine. On Linux it can run directly. Install Podman for your operating system and complete any platform prerequisites, such as the Windows virtualization setup. [Podman machine documentation](https://docs.podman.io/en/stable/markdown/podman-machine.1.html)

From this repository's directory:

```sh
pnpm install
pnpm dev
```

Typeset opens the most recent available project, or creates **The shape of an idea**, a small editable sample. Open **Set up LaTeX engine**, then **Set up compiler**. Setup detects Podman, initializes a machine if necessary on macOS/Windows, starts a stopped machine, and builds the compiler image. Allow several minutes and several GB of free disk space for the first download. Progress appears in the compilation output. Subsequent compilation works offline.

If you prefer to prepare the compiler in a terminal, start your Podman engine and run:

```sh
pnpm compiler:build
```

This builds `localhost/typeset-tex:1` from `compiler/Containerfile`. The `docker.io` base-image address is an OCI registry address; it does not require installing or running Docker.

## Write and compile

- Use the project menu to create a project, open a folder, import a ZIP, or clone a GitHub repository. Projects contain ordinary `.tex`, `.bib`, image, and other source files.
- Use the file sidebar to add files/folders, import assets, rename files, or move files to the operating system's Trash. The editor includes LaTeX highlighting, completion, folding, undo, and find/replace.
- Edits autosave after a brief pause. **Cmd/Ctrl+S** saves immediately. The save indicator shows whether work is saved or a write failed.
- Press **Recompile** or **Cmd/Ctrl+Enter**. Enable **Auto-compile** for compilation after a pause in typing. A successful build refreshes the PDF and preserves its page and zoom. The last successful PDF stays visible when compilation fails.
- **Main document** above the editor shows the file used for compilation. Choose your root document here (for example, `resume.tex`), even when editing a section or helper file. When opening an existing folder for the first time, Typeset looks for a document entrypoint and prefers root-level documents over nested examples. An existing saved selection is preserved.
- Open compilation output for the build log and diagnostics. Click a diagnostic with a source location to jump to that line. **Stop compilation** cancels the active build.
- PDF controls provide page navigation, zoom, fit width, selectable text, and search across matching pages. The download button exports the compiled PDF.
- In **Settings**, choose the main `.tex` document, pdfLaTeX/XeLaTeX/LuaLaTeX, editor font size, and Paper/Midnight appearance.

The compiler uses `latexmk`, including bibliography and reference passes. The image includes common LaTeX packages, Biber, and free fonts, including Lato and Font Awesome 5 Free for resume templates. Host-installed fonts are not automatically available inside the compiler. Add missing free packages/fonts to `compiler/Containerfile` and rebuild when needed. Typeset detects outdated compiler images and offers a rebuild through compiler setup. Project `.latexmkrc` files and shell escape are disabled; packages requiring external shell commands are not supported by the default compiler.

## Work in the terminal

Choose **Terminal** in the status bar, **View → Toggle terminal**, or **Ctrl + backtick** to open the embedded terminal. It starts your normal system shell in the current project folder, with your host's installed tools and Git credentials. Commands run on your computer; the LaTeX compiler runs separately in Podman. You can use ordinary Git commands, including interactive sign-in, branch changes, and conflict resolution. For example:

```sh
git status
git diff
git log --oneline -5
```

Typeset saves pending editor changes before sending Enter or a pasted multiline command to the shell. If saving fails or a file has conflicting edits on disk, resolve that issue before retrying the command. The file tree and open files refresh when the app regains focus and every two seconds while the terminal is in use; the terminal toolbar also has **Refresh project files**. When an external edit conflicts with unsaved text, Typeset keeps your editor text and offers **Use disk version** or **Save edits as copy**. Review the conflict before choosing which content to keep.

Hiding the terminal keeps its shell, output, and running commands. **Clear terminal** clears scrollback; **Restart terminal** ends the current session and starts a new shell. Switching projects or quitting Typeset ends the embedded session and its jobs. On macOS, **Open in Terminal** in the panel, or **View → Open project in Terminal**, opens the project in Apple's Terminal app. That separate terminal keeps running independently of Typeset. The embedded terminal uses the free, MIT-licensed xterm.js and node-pty libraries. Native terminal integration is macOS-only; Windows and Linux still require native testing.

## Versions and GitHub

**Save a version** creates a named Git commit on your computer. History supports comparing changes and restoring an earlier version. Restore saves changed tracked/untracked source in a safety checkpoint first, then records the restoration as a new commit. Git ignore rules still apply: ignored files are not part of checkpoints. GitHub is not needed for local history.

For GitHub:

1. For a project already on your computer, create an **empty** GitHub repository: leave **Add a README**, `.gitignore`, and license unchecked. Link it in Typeset, then **Save a version → Push**; there is nothing to Pull initially. If you want to start from a repository that already contains files, use **Clone from GitHub** instead.
2. Complete GitHub sign-in once in the embedded terminal or your system terminal. For HTTPS, install the free [GitHub CLI](https://cli.github.com/) (on macOS with Homebrew: `brew install gh`), then run the commands below and finish sign-in in your browser. Alternatively use [Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager) or an OS credential helper. Typeset's Sync buttons honor helpers from your system and global Git configuration, including macOS Keychain; a helper configured only inside a project is ignored by those buttons. For SSH, prepare a working SSH key/agent and GitHub host verification. See [GitHub's authentication guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github).
3. In **Sync → GitHub**, enter `https://github.com/owner/project.git` or `git@github.com:owner/project.git` and choose **Link repository**.
4. **Save a version**, then **Push**. Autosaving files alone does not create a commit. Use **Pull** to fetch and apply remote changes after committing your local work.

```sh
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git --hostname github.com
```

The first command signs in; the second connects Git to that saved sign-in. Linking a repository URL in Typeset does not authenticate your account. If Git reports “could not read Username” or “terminal prompts disabled,” complete the one-time sign-in above and retry. The Sync buttons cannot answer interactive prompts; use the embedded or system terminal for commands that require them. Do not use your GitHub account password or put a token in a repository URL. [GitHub CLI login](https://cli.github.com/manual/gh_auth_login), [Git credential setup](https://cli.github.com/manual/gh_auth_setup-git).

Configure your commit identity with Git if desired; otherwise Typeset uses a local fallback identity:

```sh
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Pull accepts fast-forward updates. If you initialized both the local project and GitHub repository separately, Git reports **unrelated histories**. After saving local changes, inspect both repositories and join their histories once with Git's `merge --allow-unrelated-histories`; resolve any conflicts while preserving the desired content, then push the resulting merge. Typeset does not automatically merge independent projects or overwrite remote history. Other diverged branches and existing conflicts also require resolution with Git in the embedded or system terminal. The built-in Sync controls accept repository URLs on `github.com`; embedded credentials, GitHub Enterprise, submodule setup, and Git LFS workflows are not supported by those controls. Keep authentication tokens out of repository URLs and source files.

## Google Drive snapshots

Drive stores each snapshot as a separate project ZIP. Restoring creates a **new local project folder**, so it does not overwrite your current project. Snapshots are explicit backups, not live folder synchronization or Git history.

Configure your own free Desktop OAuth client:

1. Create/select a project in [Google Cloud Console](https://console.cloud.google.com/) and enable **Google Drive API**. No paid billing configuration is needed for this setup.
2. Configure **Google Auth platform → Branding** and **Audience**. For a personal Google account, use an External audience; while Testing, add your own Google account as a test user.
3. In **Data Access**, add only `https://www.googleapis.com/auth/drive.file`. This limits access to files created or explicitly opened with the app. [Google's scope documentation](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
4. In **Clients**, create an OAuth client with application type **Desktop app**. Copy its client ID and client secret into **Typeset Settings → Google Drive connection**, then save settings. See [Google's Desktop client setup guide](https://developers.google.com/workspace/drive/api/quickstart/nodejs).
5. In **Sync → Google Drive**, choose **Connect Google Drive**. Complete consent in your browser and return to Typeset. Choose **Save snapshot** to upload the current project.

Enter only the desktop client ID and client secret in the app. Do not paste access tokens or refresh tokens into Settings, project files, or Git. OAuth tokens are encrypted with Electron's operating-system credential storage. Linux needs an available secure keyring; the app refuses plaintext token storage. An unsigned macOS rebuild may prompt for Keychain access again.

An External OAuth app in Testing normally receives refresh tokens that expire after seven days for Drive access. Reconnect when the app reports expiration or revoked access. [Google's token-expiration guidance](https://developers.google.com/identity/protocols/oauth2#expiration)

Keep Cloud billing disabled and remain within the existing account's free storage and API allowances. Typeset does not purchase storage or request paid quota upgrades. Google currently provides standard Drive API use without additional charges but has announced future charges for quota overages; consult its [current limits and pricing](https://developers.google.com/workspace/drive/api/guides/limits). When an allowance is exhausted, keep working locally and free storage or retry later.

## Your files

New projects use the folder you choose. `.typeset.json` records the main file, engine, and project identifier. `.git` contains local version history. **Export project ZIP** produces a portable source archive including `.typeset.json`, excluding `.git`, `.typeset`, and `node_modules`; it does not carry Git history. Preserve or clone the repository separately when you need that history. ZIPs also open in other LaTeX editors.

The initial sample lives in the app's user-data directory under `projects/The shape of an idea`. Settings, encrypted Drive tokens, and cached build results also live in user data, separate from ordinary project folders. Typical locations are:

| Platform | User-data directory                                |
| -------- | -------------------------------------------------- |
| macOS    | `~/Library/Application Support/Typeset`            |
| Windows  | `%APPDATA%\Typeset`                                |
| Linux    | `$XDG_CONFIG_HOME/Typeset`, or `~/.config/Typeset` |

For isolated development, `TYPESET_DATA_DIR` overrides that directory. `TYPESET_PODMAN_PATH` can point to a Podman executable that is not detected automatically. These are process environment variables, not project settings.

Current size limits include 5 MB per editable text file, 20 MB per imported asset, and 100 MB per project compilation/archive. Each compilation attempt has a two-minute execution limit; an auxiliary-cache failure can trigger one clean retry. Symbolic links inside projects are not supported. There is no simultaneous multi-user editing, background cloud sync, or PDF-to-source SyncTeX navigation in this release.

## Development and packaging

| Command                   | Result                                               |
| ------------------------- | ---------------------------------------------------- |
| `pnpm dev`                | Start Vite and the Electron desktop app              |
| `pnpm typecheck`          | Check TypeScript                                     |
| `pnpm test`               | Run service tests with Vitest                        |
| `pnpm test:desktop`       | Exercise the built app in a real Electron window     |
| `pnpm build`              | Typecheck and build renderer/main/preload bundles    |
| `pnpm start`              | Open the built desktop app                           |
| `pnpm package`            | Build an unpacked platform application in `release/` |
| `pnpm dist`               | Build platform distribution files in `release/`      |
| `pnpm compiler:build`     | Build the local Podman compiler image                |
| `node compiler/smoke.mjs` | Exercise the real compiler with all three engines    |

The real compiler smoke check needs a running Podman engine and the image already built. It checks nested source files, mathematics, bibliography compilation, resume fonts, recovery from stale auxiliary files, and preservation of the previous PDF after a LaTeX error. Service tests cover project archives and paths, Git checkpoints/restoration, compiler lifecycle, and Drive OAuth/snapshots with mocked network responses. Live GitHub and Google Drive checks require your own configured accounts.

Run `pnpm build` before `pnpm test:desktop`, with Podman running and the compiler image ready. The desktop smoke check uses a temporary user-data directory and exercises file creation, autosave, rename, main-document selection, Git checkpoints/restoration, real compilation, PDF display, auto-compile, and error handling. Its screenshot is written to `test-results/desktop-smoke.png`. Development validation on macOS has passed TypeScript/build, service regression tests, the complete Electron desktop smoke workflow, and real compiler checks with all three LaTeX engines; native Windows/Linux validation remains outstanding.

Build and test desktop packages on each target operating system. Configured outputs are DMG/ZIP on macOS, NSIS/portable on Windows, and AppImage/DEB on Linux. The Podman image is portable; desktop executables and installers are platform-specific. macOS desktop checks do not establish Windows/Linux compatibility, and those platforms still need native testing.

No paid signing credentials, notarization, app-store account, or automatic-update service are configured. Local builds remain free. Downloaded unsigned or ad-hoc-signed applications can require manual OS approval, and macOS credential storage may ask for permission after rebuilding. See [Electron's distribution guidance](https://www.electronjs.org/docs/latest/tutorial/code-signing).

### Architecture

| Area           | Implementation and reason                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Desktop        | Electron + TypeScript: a consistent Chromium renderer and direct local filesystem/process integration |
| Interface      | React + Vite: reusable UI components and a quick development loop                                     |
| Editor         | CodeMirror 6: extensible text editing and LaTeX syntax support                                        |
| PDF            | PDF.js: an embedded viewer with selectable text, without a paid PDF SDK                               |
| Terminal       | xterm.js + node-pty: an embedded terminal connected to a persistent local shell                       |
| Compilation    | TeX Live + `latexmk` in Podman: repeatable local compiler environments                                |
| History/backup | Ordinary Git repositories and Drive ZIPs: portable files and explicit version control                 |

`src/App.tsx` coordinates the workspace; `src/components/` contains the editor, PDF viewer, and terminal panel. `electron/main.ts` owns the desktop window and IPC handlers; `electron/preload.ts` exposes the typed app API. `electron/services/` separates projects, compiler jobs, terminal sessions, Git, and Drive. `shared/types.ts` defines their contract. `compiler/` contains the image, compilation entrypoint, and real integration smoke check; `tests/` contains service tests.

The renderer runs with context isolation and no direct Node.js access. Compilation uses a copied project snapshot in an unprivileged container with networking disabled; it does not bind-mount your project or home directory. Only successful PDF builds replace the preview. Source, PDF, and credentials stay local until you explicitly use a connected service.

Typeset's source is available under the [MIT license](LICENSE). Third-party libraries, TeX packages, and fonts retain their respective open-source licenses.
>>>>>>> a5bae36 (First commit)
