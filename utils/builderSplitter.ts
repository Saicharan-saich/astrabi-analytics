export const BUILDER_SPLIT_DEFAULT = 380;
export const BUILDER_SPLIT_MIN = 320;
export const BUILDER_SPLIT_MAX = 680;
export const BUILDER_RESULT_MIN = 480;
export const BUILDER_SPLITTER_WIDTH = 24;

export function builderSplitMaximum(workspaceWidth: number): number {
    return Math.max(
        BUILDER_SPLIT_MIN,
        Math.min(BUILDER_SPLIT_MAX, workspaceWidth - BUILDER_RESULT_MIN - BUILDER_SPLITTER_WIDTH),
    );
}

export function clampBuilderSplit(requestedWidth: number, workspaceWidth: number): number {
    const safeWidth = Number.isFinite(requestedWidth) ? requestedWidth : BUILDER_SPLIT_DEFAULT;
    return Math.round(Math.max(BUILDER_SPLIT_MIN, Math.min(safeWidth, builderSplitMaximum(workspaceWidth))));
}
