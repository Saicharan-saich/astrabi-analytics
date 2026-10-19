export type MenuPlacement = 'auto' | 'up' | 'down';

export interface QuerySelectMenuPosition {
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    placement: 'up' | 'down';
    detached: boolean;
}

interface PositionInput {
    anchor: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'width' | 'height'>;
    viewportWidth: number;
    viewportHeight: number;
    desiredHeight: number;
    preference: MenuPlacement;
}

/** Keep a picker usable as its anchor approaches the edge of a scrolling panel. */
export function querySelectMenuPosition({
    anchor, viewportWidth, viewportHeight, desiredHeight, preference,
}: PositionInput): QuerySelectMenuPosition {
    const padding = 8;
    const gap = 6;
    const above = Math.max(0, anchor.top - padding - gap);
    const below = Math.max(0, viewportHeight - anchor.bottom - padding - gap);
    const targetHeight = Math.min(desiredHeight, Math.max(96, viewportHeight - padding * 2));

    let placement: 'up' | 'down';
    if (preference === 'auto') placement = below >= targetHeight || below >= above ? 'down' : 'up';
    else {
        const preferredSpace = preference === 'up' ? above : below;
        const otherSpace = preference === 'up' ? below : above;
        placement = preferredSpace < targetHeight && otherSpace > preferredSpace
            ? (preference === 'up' ? 'down' : 'up')
            : preference;
    }

    // When neither side fits, detach into the viewport. Do not progressively
    // shorten the option list as the user scrolls its containing page.
    const detached = Math.max(above, below) < targetHeight;
    const availableWidth = Math.max(1, viewportWidth - padding * 2);
    const width = Math.min(availableWidth, 320, Math.max(anchor.width, Math.min(240, Math.max(160, availableWidth))));
    const left = Math.max(padding, Math.min(anchor.left, viewportWidth - width - padding));
    const top = detached
        ? Math.max(padding, Math.min(
            anchor.top + anchor.height / 2 - targetHeight / 2,
            viewportHeight - targetHeight - padding,
        ))
        : placement === 'up' ? anchor.top - gap : anchor.bottom + gap;

    return { top, left, width, maxHeight: targetHeight, placement, detached };
}
