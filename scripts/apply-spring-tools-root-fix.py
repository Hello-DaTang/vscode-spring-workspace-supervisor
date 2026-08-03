#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"Unable to apply patch: {label}")
    return text.replace(old, new, 1)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: apply-spring-tools-root-fix.py <spring-tools-root>")

    root = Path(sys.argv[1]).resolve()
    cache_file = root / "headless-services/spring-boot-language-server/src/main/java/org/springframework/ide/vscode/boot/jdt/ls/JdtLsProjectCache.java"
    manager_file = root / "headless-services/commons/commons-language-server/src/main/java/org/springframework/ide/vscode/commons/languageserver/java/ls/ClasspathListenerManager.java"
    package_file = root / "vscode-extensions/vscode-spring-boot/package.json"

    cache = cache_file.read_text(encoding="utf-8")
    cache = replace_once(
        cache,
        "import java.time.Duration;\n",
        "",
        "remove destructive registration timeout import",
    )
    cache = replace_once(
        cache,
        "\tprivate static final Duration INITIALIZE_TIMEOUT = Duration.ofSeconds(10);\n",
        "",
        "remove destructive registration timeout",
    )
    cache = replace_once(
        cache,
        "\tprivate Mono<Disposable> classpathListenerRequest;\n",
        "\tprivate Mono<Disposable> classpathListenerRequest;\n\tprivate Disposable classpathListenerRegistration;\n",
        "add in-flight registration handle",
    )

    method_pattern = re.compile(
        r"\tprivate synchronized void enableClasspathListener\(boolean enabled\) \{.*?\n\t\}\n\t\n\t@Override\n\tpublic Collection<\? extends IJavaProject> all\(\)",
        re.DOTALL,
    )
    replacement = """\tprivate synchronized void enableClasspathListener(boolean enabled) {
\t\tlog.info(\"Enable classpath listener enabled = \" + enabled + \" current enablement = \" + classpathListenerEnabled);
\t\tif (enabled) {
\t\t\tif (classpathListenerEnabled || classpathListenerRequest != null) {
\t\t\t\treturn;
\t\t\t}

\t\t\t/*
\t\t\t * Do not put a wall-clock timeout around this request. On large workspaces the
\t\t\t * JDT extension can start streaming the initial classpath snapshot before the
\t\t\t * JSON-RPC response to sts.java.addClasspathListener reaches Boot LS. The
\t\t\t * callback channel is already functional during that period. Cancelling it on a
\t\t\t * timeout unregisters the callback command while JDT still has queued events,
\t\t\t * causing command-not-found errors and an empty project cache.
\t\t\t */
\t\t\tlog.info(\"Adding classpath listener without a destructive registration timeout\");
\t\t\tclasspathListenerEnabled = true;
\t\t\tnotifyProjectObserverSupported();

\t\t\tfinal Mono<Disposable> request = server.addClasspathListener(CLASSPATH_LISTENER)
\t\t\t\t\t.doOnSubscribe(x -> log.debug(\"addClasspathListener ...\"))
\t\t\t\t\t.doOnSuccess(x -> log.debug(\"addClasspathListener DONE\"));

\t\t\tclasspathListenerRequest = request;
\t\t\tDisposable registration = request.subscribe(
\t\t\t\t\tdisposable -> completeClasspathListenerRegistration(request, disposable),
\t\t\t\t\terror -> failClasspathListenerRegistration(request, error)
\t\t\t);
\t\t\tif (classpathListenerRequest == request) {
\t\t\t\tclasspathListenerRegistration = registration;
\t\t\t} else {
\t\t\t\tregistration.dispose();
\t\t\t}
\t\t} else {
\t\t\tlog.info(\"Removing classpath listener enabled=false\");
\t\t\tclasspathListenerRequest = null;
\t\t\tif (classpathListenerRegistration != null) {
\t\t\t\tclasspathListenerRegistration.dispose();
\t\t\t\tclasspathListenerRegistration = null;
\t\t\t}
\t\t\tDISPOSABLE.update(Disposables.single());
\t\t\tboolean changed = classpathListenerEnabled;
\t\t\tclasspathListenerEnabled = false;
\t\t\tif (changed) {
\t\t\t\tnotifyProjectObserverSupported();
\t\t\t}
\t\t}
\t}

\tprivate synchronized void completeClasspathListenerRegistration(Mono<Disposable> request, Disposable disposable) {
\t\tif (request != classpathListenerRequest) {
\t\t\tdisposable.dispose();
\t\t\treturn;
\t\t}

\t\tclasspathListenerRequest = null;
\t\tclasspathListenerRegistration = null;
\t\tDISPOSABLE.update(disposable);
\t\tlog.info(\"Classpath listener registration response received; initial snapshot channel remains active.\");
\t}

\tprivate synchronized void failClasspathListenerRegistration(Mono<Disposable> request, Throwable error) {
\t\tif (request != classpathListenerRequest) {
\t\t\treturn;
\t\t}

\t\tclasspathListenerRequest = null;
\t\tclasspathListenerRegistration = null;
\t\tDISPOSABLE.update(Disposables.single());
\t\tboolean changed = classpathListenerEnabled;
\t\tclasspathListenerEnabled = false;
\t\tlog.error(\"Unable to register classpath listener with JDT.\", error);
\t\tif (changed) {
\t\t\tnotifyProjectObserverSupported();
\t\t}
\t}
\t
\t@Override
\tpublic Collection<? extends IJavaProject> all()"""
    cache, count = method_pattern.subn(replacement, cache, count=1)
    if count != 1:
        raise RuntimeError("Unable to apply patch: replace classpath listener state machine")
    cache_file.write_text(cache, encoding="utf-8")

    manager = manager_file.read_text(encoding="utf-8")
    manager = replace_once(
        manager,
        "import java.util.UUID;\n",
        "import java.util.UUID;\nimport java.util.concurrent.atomic.AtomicBoolean;\n",
        "add cleanup guard import",
    )
    manager = replace_once(
        manager,
        "\t\tDisposable cleanups = () -> {\n\t\t\tlog.info(\"Unregistering classpath callback \"+callbackCommandId +\" ...\");",
        "\t\tAtomicBoolean cleanupStarted = new AtomicBoolean();\n\t\tDisposable cleanups = () -> {\n\t\t\tif (!cleanupStarted.compareAndSet(false, true)) {\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tlog.info(\"Unregistering classpath callback \"+callbackCommandId +\" ...\");",
        "make cleanup idempotent",
    )
    manager = replace_once(
        manager,
        "\t\treturn\n\t\t\tregisterCallbackCommand\n\t\t\t.then(registerClasspathListener)\n\t\t\t.thenReturn(cleanups);",
        "\t\treturn\n\t\t\tregisterCallbackCommand\n\t\t\t.then(registerClasspathListener)\n\t\t\t.thenReturn(cleanups)\n\t\t\t.doOnError(error -> cleanups.dispose())\n\t\t\t.doOnCancel(cleanups::dispose);",
        "cleanup genuine failed or explicitly cancelled registrations",
    )
    manager_file.write_text(manager, encoding="utf-8")

    package = json.loads(package_file.read_text(encoding="utf-8"))
    package["version"] = "2.4.2"
    package["displayName"] = "Spring Boot Tools (Root-Fix Build)"
    package["description"] = (
        "Unofficial EPL-1.0 root-fix build of Spring Boot Tools. "
        "Keeps the JDT classpath callback alive while large initial workspace snapshots are streamed."
    )
    package["rootFixBuild"] = {
        "source": "https://github.com/spring-projects/spring-tools",
        "patchRepository": "https://github.com/Hello-DaTang/vscode-spring-workspace-supervisor",
        "patch": "classpath-listener-backpressure-v2",
    }
    package_file.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")

    print("Applied Spring Boot Tools classpath-listener root fix v2.")


if __name__ == "__main__":
    main()
