export function isEndpointPathQuery(query: string): boolean {
    return query.trim().includes('/');
}

export function matchesEndpointSymbol(
    query: string,
    symbolName: string,
    containerName?: string,
): boolean {
    const needle = normalize(query);
    if (!needle) {
        return true;
    }

    const haystack = normalize(`${symbolName} ${containerName ?? ''}`);
    if (haystack.includes(needle)) {
        return true;
    }

    // Users commonly type a leading slash while some Spring symbols render the
    // HTTP method before the path or omit the first slash from their label.
    const withoutLeadingSlash = needle.replace(/^\/+/, '');
    return withoutLeadingSlash.length > 0 && haystack.includes(withoutLeadingSlash);
}

function normalize(value: string): string {
    return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}
