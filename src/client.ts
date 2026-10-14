/** Optional browser enhancement: unclipped, dismissible tooltips with no framework dependency. */
export function enhanceThreeslash(container: HTMLElement | Document = document): () => void {
    const doc = 'documentElement' in container ? container : container.ownerDocument;
    const ownerWindow = doc.defaultView;
    if (!ownerWindow) {
        return () => {
            /* No window means no listeners were installed. */
        };
    }
    const view = ownerWindow;
    let active: HTMLElement | undefined;
    let dismissed: HTMLElement | undefined;
    let overlay: HTMLElement | undefined;
    let popup: HTMLElement | undefined;
    let describedBy: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const enhanced = new Set<HTMLElement>();

    function hide() {
        if (timer) {
            clearTimeout(timer);
        }
        if (active) {
            if (describedBy === null) {
                active.removeAttribute('aria-describedby');
            } else {
                active.setAttribute('aria-describedby', describedBy);
            }
        }
        overlay?.remove();
        active = undefined;
        overlay = undefined;
        popup = undefined;
    }

    function position() {
        if (!active || !popup) {
            return;
        }
        if (!active.isConnected) {
            hide();
            return;
        }
        const anchor = active.getBoundingClientRect();
        const box = popup.getBoundingClientRect();
        const left = Math.max(12, Math.min(anchor.left, view.innerWidth - box.width - 12));
        const preferred = anchor.top - box.height - 6;
        const top = preferred >= 12 ? preferred : Math.min(anchor.bottom + 6, view.innerHeight - box.height - 12);
        popup.style.left = `${left}px`;
        popup.style.top = `${Math.max(12, top)}px`;
    }

    function triggerFor(target: EventTarget | null): HTMLElement | undefined {
        if (!(target instanceof view.Element)) {
            return undefined;
        }
        const trigger = target.closest<HTMLElement>('.threeslash-hover');
        return trigger && container.contains(trigger) ? trigger : undefined;
    }

    function show(trigger: HTMLElement) {
        if (timer) {
            clearTimeout(timer);
        }
        if (active === trigger || dismissed === trigger) {
            return;
        }
        const original = trigger.querySelector<HTMLElement>('.threeslash-popup');
        if (!original) {
            return;
        }
        const cloned = original.cloneNode(true);
        if (!(cloned instanceof view.HTMLElement)) {
            return;
        }
        hide();
        const pre = trigger.closest<HTMLElement>('.threeslash');
        if (pre) {
            pre.dataset['threeslashEnhanced'] = '';
            enhanced.add(pre);
        }
        active = trigger;
        describedBy = trigger.getAttribute('aria-describedby');
        overlay = doc.createElement('div');
        overlay.className = 'threeslash';
        overlay.style.colorScheme = view.getComputedStyle(trigger).colorScheme;
        popup = cloned;
        popup.classList.add('threeslash-floating');
        popup.id = `${original.id}-active`;
        popup.style.display = 'block';
        trigger.setAttribute('aria-describedby', popup.id);
        overlay.append(popup);
        doc.body.append(overlay);
        // The native top layer also escapes overflow and transformed ancestors.
        if ('showPopover' in popup) {
            popup.popover = 'manual';
            popup.showPopover();
        }
        position();
    }

    function delayHide() {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            if (
                active &&
                doc.activeElement !== active &&
                popup?.contains(doc.activeElement) !== true &&
                popup?.matches(':hover') !== true
            ) {
                hide();
            }
        }, 100);
    }

    function pointerOver(event: Event) {
        if (event.target instanceof view.Node && popup?.contains(event.target) === true) {
            if (timer) {
                clearTimeout(timer);
            }
            return;
        }
        const trigger = triggerFor(event.target);
        if (trigger) {
            show(trigger);
        }
    }

    function pointerOut(event: PointerEvent) {
        const next = event.relatedTarget instanceof view.Node ? event.relatedTarget : null;
        if (dismissed && !dismissed.contains(next)) {
            dismissed = undefined;
        }
        if (active?.contains(next) === true || popup?.contains(next) === true) {
            return;
        }
        delayHide();
    }

    function focusIn(event: Event) {
        if (event.target instanceof view.Node && popup?.contains(event.target) === true) {
            return;
        }
        const trigger = triggerFor(event.target);
        if (trigger) {
            show(trigger);
        } else {
            hide();
        }
    }

    function focusOut(event: Event) {
        if (triggerFor(event.target) === dismissed) {
            dismissed = undefined;
        }
        delayHide();
    }

    function keyDown(event: KeyboardEvent) {
        if (event.key === 'Tab' && active && popup) {
            const links = popup.querySelectorAll<HTMLAnchorElement>('a[href]');
            const [first] = links;
            if (doc.activeElement === active && !event.shiftKey && first) {
                event.preventDefault();
                first.focus();
            } else if (doc.activeElement === first && event.shiftKey) {
                event.preventDefault();
                active.focus();
            } else if (doc.activeElement === links.item(links.length - 1) && !event.shiftKey) {
                // Resume the document's natural tab order after the trigger.
                active.focus();
                hide();
            }
        }
        if (event.key === 'Escape' && active) {
            if (popup?.contains(doc.activeElement) === true) {
                active.focus();
            }
            dismissed = active;
            hide();
        }
    }

    doc.addEventListener('pointerover', pointerOver);
    doc.addEventListener('pointerout', pointerOut);
    doc.addEventListener('focusin', focusIn);
    doc.addEventListener('focusout', focusOut);
    doc.addEventListener('keydown', keyDown);
    view.addEventListener('resize', position);
    doc.addEventListener('scroll', position, true);

    return () => {
        hide();
        for (const pre of enhanced) {
            delete pre.dataset['threeslashEnhanced'];
        }
        doc.removeEventListener('pointerover', pointerOver);
        doc.removeEventListener('pointerout', pointerOut);
        doc.removeEventListener('focusin', focusIn);
        doc.removeEventListener('focusout', focusOut);
        doc.removeEventListener('keydown', keyDown);
        view.removeEventListener('resize', position);
        doc.removeEventListener('scroll', position, true);
    };
}
