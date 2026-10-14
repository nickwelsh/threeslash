'use client';

import { useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import type { CodeBlockProps } from 'fumadocs-ui/components/codeblock';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { enhanceThreeslash } from './client.js';

export { Popup, PopupContent, PopupTrigger } from 'fumadocs-twoslash/ui';

export type ThreeslashPreProps = CodeBlockProps & {
    'data-threeslash-code'?: string;
    style?: ComponentProps<'pre'>['style'];
};

function CopyPhp({ source, matchTwoslashStyling }: { source: string; matchTwoslashStyling: boolean }) {
    const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
    useEffect(() => {
        if (state === 'idle') {
            return;
        }
        const timer = setTimeout(() => setState('idle'), 2000);
        return () => clearTimeout(timer);
    }, [state]);
    async function copySource() {
        try {
            await navigator.clipboard.writeText(source);
            setState('copied');
        } catch {
            setState('failed');
        }
    }
    const labels = { idle: 'Copy PHP', copied: 'Copied', failed: 'Copy failed — retry' };
    return (
        <button
            type="button"
            className={matchTwoslashStyling ? buttonVariants({ size: 'sm' }) : 'threeslash-copy'}
            aria-live="polite"
            onClick={() => {
                void copySource();
            }}
        >
            {labels[state]}
        </button>
    );
}

/** Use as the MDX `pre` component. Ordinary code blocks retain Fumadocs' controls. */
export function ThreeslashPre({ children, 'data-threeslash-code': source, ...props }: ThreeslashPreProps) {
    const matchTwoslashStyling = !(props.className?.split(/\s+/u).includes('threeslash') ?? false);
    const ref = useRef<HTMLElement>(null);
    // oxlint-disable react/exhaustive-effect-dependencies -- Regenerated MDX children must reset active tooltips even when the visible source is unchanged.
    useEffect(() => {
        if (matchTwoslashStyling || source === undefined || !ref.current) {
            return;
        }
        return enhanceThreeslash(ref.current);
    }, [source, children, matchTwoslashStyling]);
    // oxlint-enable react/exhaustive-effect-dependencies
    const { Actions } = props;
    return (
        <CodeBlock
            {...props}
            ref={ref}
            {...(source === undefined
                ? {}
                : {
                      allowCopy: false,
                      Actions: ({ className }: { className?: string }) => {
                          const button =
                              props.allowCopy === false || props.allowCopy === 'false' ? null : (
                                  <CopyPhp source={source} matchTwoslashStyling={matchTwoslashStyling} />
                              );
                          return Actions ? (
                              <Actions {...(className === undefined ? {} : { className })}>{button}</Actions>
                          ) : (
                              <div className={className}>{button}</div>
                          );
                      },
                  })}
        >
            <Pre
                {...(source === undefined
                    ? {}
                    : { className: matchTwoslashStyling ? 'twoslash' : 'threeslash', 'data-threeslash-code': source })}
            >
                {children}
            </Pre>
        </CodeBlock>
    );
}
