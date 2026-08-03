export interface ParsedMainClass {
    readonly className: string;
    readonly packageName?: string;
    readonly fullyQualifiedName: string;
}

const SPRING_BUILD_MARKERS = [
    'spring-boot',
    'org.springframework.boot',
    'org.springframework:spring-context',
    'org.springframework:spring-beans',
] as const;

export function isSpringBuildText(text: string): boolean {
    const normalized = text.toLowerCase();
    return SPRING_BUILD_MARKERS.some((marker) => normalized.includes(marker));
}

export function isAggregatorPom(text: string): boolean {
    return /<packaging>\s*pom\s*<\/packaging>/i.test(text);
}

export function extractMavenArtifactId(text: string): string | undefined {
    const withoutParent = text.replace(/<parent>[\s\S]*?<\/parent>/i, '');
    return firstCapture(withoutParent, /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/i);
}

export function parseSpringBootMainClass(text: string): ParsedMainClass | undefined {
    const annotationIndex = text.search(/@SpringBootApplication\b/);
    if (annotationIndex < 0) {
        return undefined;
    }

    const afterAnnotation = text.slice(annotationIndex, annotationIndex + 4000);
    const className = firstCapture(
        afterAnnotation,
        /\b(?:public\s+)?(?:final\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
    );
    if (!className) {
        return undefined;
    }

    const packageName = firstCapture(text, /^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m);
    return {
        className,
        packageName,
        fullyQualifiedName: packageName ? `${packageName}.${className}` : className,
    };
}

export function containsSpringRuntimeClasspath(entries: readonly string[]): boolean {
    return entries.some((entry) => {
        const normalized = entry.replaceAll('\\', '/').toLowerCase();
        return normalized.includes('/spring-boot-')
            || normalized.includes('/spring-boot/')
            || normalized.includes('/spring-context-')
            || normalized.includes('/spring-beans-');
    });
}

function firstCapture(text: string, expression: RegExp): string | undefined {
    const match = expression.exec(text);
    return match?.[1]?.trim() || undefined;
}
