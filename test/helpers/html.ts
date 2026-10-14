import type { DefaultTreeAdapterMap } from 'parse5';

export function elements(node: DefaultTreeAdapterMap['node']): Array<DefaultTreeAdapterMap['element']> {
    if (!('childNodes' in node)) {
        return [];
    }
    return node.childNodes.flatMap((child) => [...('tagName' in child ? [child] : []), ...elements(child)]);
}
