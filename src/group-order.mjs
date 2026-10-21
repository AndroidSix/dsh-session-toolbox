export const UNGROUPED = 'ungrouped';

/** Old documents omit the position and retain their existing ungrouped-last
 * layout. The built-in group derives membership instead of storing project IDs. */
export function orderedGroups(groups, ungroupedIndex = groups.length) {
 const ordered = [...groups];
 ordered.splice(ungroupedIndex, 0, { id: UNGROUPED, workspaceIds: [] });
 return ordered;
}
