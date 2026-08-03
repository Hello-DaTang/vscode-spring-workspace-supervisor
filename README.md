# Spring Workspace Supervisor

A resilient VS Code companion for large Maven/Gradle Spring Boot workspaces.

The extension addresses a recurring failure mode in which Spring Boot Tools or the official Spring Boot Dashboard starts while the Red Hat Java Language Server is still importing projects. In that state, classpath-listener registration may time out and the official Dashboard can remain empty even though the projects are valid.

## Install

Download the latest Supervisor `.vsix` from the repository **Releases** page. The asset is named like:

```text
spring-workspace-supervisor-v0.4.0.vsix
```

Install it through **Extensions → ... → Install from VSIX...**, or run:

```bash
code --install-extension spring-workspace-supervisor-v0.4.0.vsix --force
```

Reload VS Code after installation. The **Spring Supervisor** activity-bar entry appears when a Java/Spring workspace is opened.

## Optional Spring Boot Tools root-fix build

The repository also builds an unofficial, source-auditable Spring Boot Tools VSIX from a pinned upstream commit. It retains the extension ID `vmware.vscode-spring-boot`, so it replaces the Marketplace build and remains compatible with the official Spring Boot Dashboard.

The root-fix build:

- extends JDT classpath-listener registration from 10 seconds to 3 minutes;
- reports classpath listening as supported only after registration succeeds;
- explicitly handles terminal registration errors instead of producing Reactor `onErrorDropped`;
- cancels in-flight registration when disabled;
- cleans callback commands and dynamic capabilities after failure or cancellation.

Before testing the root-fix VSIX, use:

```json
{
  "springSupervisor.strictSpringStartGate": false,
  "springSupervisor.waitForWorkspaceInitialized": true,
  "springSupervisor.verifyRuntimeClasspath": false
}
```

The longer internal timeout is intended to let the first Spring registration survive a large Java workspace import. The Supervisor should therefore not stop that registration while this build is being tested.

Install the root-fix package with:

```bash
code --install-extension spring-boot-tools-rootfix-2.4.1.vsix --force
```

Because the VSIX uses the same extension ID as the Marketplace extension, disable automatic updates for **Spring Boot Tools** while testing it. Reinstalling the Marketplace version restores the official build.

The root-fix source transformation is stored in `scripts/apply-spring-tools-root-fix.py`, and the reproducible build is defined in `.github/workflows/build-spring-tools-rootfix.yml`.

## Ctrl+T endpoint path search

Supervisor 0.4.0 adds an optional Workspace Symbol Provider for Spring Endpoint Mappings. Once Spring static data is available, press `Ctrl+T` and type a path containing `/`, for example:

```text
/admin-api/system/users
```

or:

```text
GET /admin-api/system/users
```

The provider asks Spring Boot Language Server for its `@/` mapping symbols, caches the result for 30 seconds, and filters it using the URL text. Disable this integration with:

```json
{
  "springSupervisor.enableSlashEndpointWorkspaceSymbols": false
}
```

This is additive: normal Java workspace symbols remain provided by the Java extension.

## Native Ctrl+T endpoint search

The extension does not replace or rebind Ctrl+T. It registers a standard VS Code Workspace Symbol Provider. When the native Ctrl+T query contains a forward slash, the provider requests Spring Endpoint Mappings and contributes matching results to the normal symbol picker.

Examples:

```text
/admin-api/system/users
GET /admin-api/system/users
```

If no results appear, open **Output → Spring Workspace Supervisor** and inspect lines beginning with `[endpoint-symbols]`.

## Automated releases

GitHub Actions builds and tests the Supervisor on every push to `main`. It reads the version from `package.json` and creates a versioned GitHub Release when the corresponding tag does not exist.

A separate workflow builds the patched Spring Boot Tools source and publishes its own Release with the VSIX, patch script, and SHA-256 checksums.

## What the Supervisor does

- Activates the Red Hat Java extension and observes its public `serverRunning`, `serverReady`, project-import, classpath-update, project-delete, server-mode, and workspace-initialized events.
- Waits for `java.workspace.initialized`, not only `serverReady()`, before authorizing Spring startup.
- Uses a configurable quiet period after Java import/classpath activity before considering the workspace stable.
- Refreshes the official Spring Boot Dashboard, Spring static data, and Logical Structure views after import settles.
- Provides its own Spring Boot application tree that does not depend on Spring Tools classpath-listener registration.
- Detects applications from Maven/Gradle build files and `@SpringBootApplication` main classes.
- Skips expensive runtime classpath verification automatically in large workspaces.
- Runs, debugs, and stops detected applications through the Java debug adapter.
- Produces a diagnostic Markdown report with Java/Spring extension state, event timestamps, detected applications, warnings, and the last error.

## Important limitation

VS Code does not expose an API that lets one extension prevent another extension from activating. The Supervisor can coordinate its own Spring startup request and perform recovery, but the root-fix VSIX is required to change Spring Boot Language Server's internal classpath-registration behavior.

## Requirements

- VS Code 1.96 or newer
- Language Support for Java by Red Hat (`redhat.java`)
- Java Debugger for VS Code for Run/Debug actions
- Optional: Spring Boot Tools (`vmware.vscode-spring-boot`)
- Optional: Spring Boot Dashboard (`vscjava.vscode-spring-boot-dashboard`)

## Development

```bash
npm install
npm test
npm run package
```

Press `F5` in VS Code to launch an Extension Development Host.

## Commands

- `Spring Supervisor: Refresh Workspace`
- `Spring Supervisor: Open Diagnostic Report`
- `Spring Supervisor: Retry Spring Index`
- `Spring Supervisor: Refresh Official Spring Dashboard`
- `Spring Supervisor: Show Supervisor Log`

## Settings

| Setting | Default | Purpose |
|---|---:|---|
| `springSupervisor.quietPeriodMs` | `2500` | Stable window after import/classpath events |
| `springSupervisor.maxMainClassFiles` | `5000` | Maximum likely main-class files scanned workspace-wide |
| `springSupervisor.strictSpringStartGate` | `true` | Issue at most one early Spring LS stop; disable for the root-fix build |
| `springSupervisor.waitForWorkspaceInitialized` | `true` | Wait for full Java workspace initialization |
| `springSupervisor.workspaceInitializationTimeoutMs` | `180000` | Fallback if the Java event is not observed |
| `springSupervisor.activateSpringToolsAfterJavaReady` | `true` | Request Spring Tools startup after Java settles |
| `springSupervisor.refreshOfficialDashboardAfterSettle` | `true` | Refresh official Spring views after settling |
| `springSupervisor.springRefreshDelayMs` | `10000` | Delay before the first official Spring refresh |
| `springSupervisor.springSecondRefreshDelayMs` | `15000` | Delay before the second recovery refresh |
| `springSupervisor.verifyRuntimeClasspath` | `false` | Optional classpath verification; slow on large workspaces |
| `springSupervisor.maxAutomaticClasspathVerifications` | `8` | Automatic verification limit |
| `springSupervisor.enableSlashEndpointWorkspaceSymbols` | `true` | Add slash URL results to Ctrl+T |
| `springSupervisor.defaultProfiles` | `[]` | Profiles used by Supervisor Run/Debug |
| `springSupervisor.vmArgs` | empty | Extra JVM arguments for Supervisor launches |

## Architecture

```text
Red Hat Java API
  ├─ serverRunning / serverReady
  ├─ java.workspace.initialized
  ├─ onDidProjectsImport
  └─ onDidClasspathUpdate
              │
              ▼
      Java readiness gate
              │
       ┌──────┼──────────────────┐
       ▼      ▼                  ▼
App scanner  Spring recovery   Ctrl+T endpoint provider
             and refresh        via Spring @/ symbols
```

## Roadmap

- Validate the root-fix build against the 64-project/881-dependency workspace.
- Upstream the classpath-listener fix to `spring-projects/spring-tools` after field validation.
- Add persisted per-application profiles, arguments, environment variables, and ports.
- Add integration tests using `@vscode/test-electron`.
