# Change Log

## 0.5.0

- Replace the native Ctrl+T picker with a compatible workspace-symbol picker that supports URL paths containing forward slashes.
- Preserve ordinary class, method, and workspace-symbol search when the query does not contain a slash.
- Query Spring Boot Language Server directly with @/ for Endpoint Mappings and bypass VS Code's second fuzzy-filter pass for URL results.
- Add springSupervisor.overrideCtrlT so the custom binding can be disabled and the native Ctrl+T restored.

## 0.4.1

- Detect the Spring Boot Tools Root-Fix backpressure build through its extension manifest.
- Bypass the one-shot early-stop gate for that build so its initial JDT classpath snapshot is never cancelled.
- Preserve an already-active Root-Fix registration without reporting the normal early-activation warning.

## 0.4.0

- Added an optional slash-aware Workspace Symbol Provider for `Ctrl+T` endpoint searches.
- Queries containing `/` reuse the Spring Boot Language Server's `@/` Endpoint Mapping symbol request.
- Added a 30-second endpoint symbol cache so typing a URL does not send one full Spring request per keystroke.
- Added an audited build pipeline for an unofficial Spring Boot Tools root-fix VSIX.
- The root-fix build extends JDT classpath-listener registration to three minutes, handles terminal errors explicitly, and cleans failed registrations.

## 0.3.0

- Wait for the Java `java.workspace.initialized` signal instead of treating `serverReady()` as full project readiness.
- Replace the repeated Spring LS stop loop with a one-shot graceful stop to prevent destroyed-stream restart loops.
- Skip expensive runtime classpath verification automatically in large workspaces.
- Refresh Spring static data before the Dashboard and perform a delayed second recovery refresh.

## 0.2.0

- Added a strict Spring start gate. If Spring Boot Tools is activated while Java is still importing, the supervisor stops its language server and restarts it after the Java workspace settles.
- Started Java readiness monitoring and application discovery concurrently, so slow source scans no longer delay Java import listeners.
- Moved Spring Tools startup ahead of the independent application scan after settlement.
- Replaced per-module source searches with one workspace-wide likely-main-class search.
- Prevented overlapping scans and added scan duration diagnostics.
- Added bounded, concurrent, timeout-protected runtime classpath verification; disabled it by default for large workspaces.
- Added a configurable delay before refreshing official Spring views.

## 0.1.0

- Initial MVP.
- Java import/classpath quiet-period coordinator.
- Independent Spring Boot application dashboard.
- Spring Tools activation and official Dashboard refresh after workspace settlement.
- Application Run/Debug/Stop actions.
- Workspace diagnostic report and health view.
