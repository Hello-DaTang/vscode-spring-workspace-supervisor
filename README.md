# Spring Workspace Supervisor

A resilient VS Code companion for large Maven/Gradle Spring Boot workspaces.

The extension addresses a recurring failure mode in which Spring Boot Tools or the official Spring Boot Dashboard starts while the Red Hat Java Language Server is still importing projects. In that state, classpath-listener registration may time out and the official Dashboard can remain empty even though the projects are valid.

## What the MVP does

- Activates the Red Hat Java extension and observes its public `serverRunning`, `serverReady`, project-import, classpath-update, project-delete, and server-mode events.
- Uses a configurable quiet period after Java import/classpath activity before considering the workspace stable.
- Activates/starts Spring Boot Tools after that stable point when it has not already been activated elsewhere.
- Refreshes the official Spring Boot Dashboard, Spring static data, and Logical Structure views after import settles.
- Provides its own Spring Boot application tree that does not depend on the Spring Tools classpath-listener registration path.
- Detects applications from Maven/Gradle build files and `@SpringBootApplication` main classes.
- Optionally verifies each application's runtime classpath through the Red Hat Java API.
- Runs, debugs, and stops detected applications through the Java debug adapter.
- Produces a diagnostic Markdown report with Java/Spring extension state, event timestamps, detected applications, warnings, and the last error.

## Important limitation

VS Code does not expose an API that lets one extension prevent another extension from activating. Therefore this extension can control **its own** Spring Tools activation request and perform recovery after Java import settles, but it cannot guarantee that the official Dashboard or another extension did not activate Spring Boot Tools earlier.

The independent **Applications** view is the fallback when the official Dashboard remains empty.

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
| `springSupervisor.maxJavaFilesPerProject` | `2000` | Maximum source files scanned per project |
| `springSupervisor.activateSpringToolsAfterJavaReady` | `true` | Request Spring Tools activation after Java settles |
| `springSupervisor.refreshOfficialDashboardAfterSettle` | `true` | Refresh official Spring views after settling |
| `springSupervisor.verifyRuntimeClasspath` | `true` | Verify Spring dependencies with Java classpath API |
| `springSupervisor.defaultProfiles` | `[]` | Profiles used by supervisor Run/Debug |
| `springSupervisor.vmArgs` | empty | Extra JVM arguments for supervisor launches |

## Architecture

```text
Red Hat Java API
  ├─ serverRunning / serverReady
  ├─ onDidProjectsImport
  ├─ onDidClasspathUpdate
  └─ onDidServerModeChange
              │
              ▼
      Java readiness gate
      (quiet-period state machine)
              │
       ┌──────┴─────────┐
       ▼                ▼
Independent app     Spring Tools activation
scanner/dashboard   + official view refresh
```

## Roadmap

- Parse Maven reactor/module relationships and Gradle multi-project metadata.
- Detect and classify known Spring/JDT LS timeout signatures from output logs.
- Add targeted Maven/Gradle project reload actions.
- Add persisted per-application profiles, arguments, environment variables, and ports.
- Add integration tests using `@vscode/test-electron`.
