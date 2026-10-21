/** Repair an updated bundle whose browser and running host generations differ.
 * Re-selecting an enabled bundle makes DSH reconcile its current on-disk patch:
 * old fibers are disposed before the new entry starts. Never replace routes or
 * start a second host ourselves (that would duplicate automatic model calls).
 */
export function createHostVersionGuard({ version, name, manager, readState }) {
 let recovery;
 const mismatch = state => new Error(`插件前后台版本不一致（界面 ${version}，后台 ${state?.pluginVersion || '未知'}）。请在插件页重新启用插件；若已更新后台，请刷新界面后重试。`);
 return async (state, repair = true) => {
  if (state?.pluginVersion === version) return;
  const service = manager();
  if (!repair || typeof service?.listBundles !== 'function' || typeof service?.setBundleEnabled !== 'function') throw mismatch(state);
  // One attempt per browser generation, shared by concurrent message controls.
  // Reading snapshots or a model failure must never trigger plugin reloads.
  if (!recovery) recovery = (async () => {
   const bundle = (await service.listBundles()).find(bundle => bundle.name === name);
   if (!bundle?.enabled || !bundle.installed || bundle.version !== version) throw mismatch(state);
   const result = await service.setBundleEnabled(name, true);
   if (result?.application !== 'applied') throw new Error('插件后台重新加载未生效。请在 DSH 插件页查看更新状态，再重新启用插件。');
   const latest = await readState();
   if (latest?.pluginVersion !== version) throw mismatch(latest);
  })();
  await recovery;
 };
}
