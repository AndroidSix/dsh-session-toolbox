/** Repair an updated bundle whose browser and running host generations differ.
 * Re-selecting an enabled bundle makes DSH reconcile its current on-disk patch:
 * old fibers are disposed before the new entry starts. Never replace routes or
 * start a second host ourselves (that would duplicate automatic model calls).
 */
import { translate } from './locale.mjs';

export function createHostVersionGuard({ version, name, manager, readState, t = (key, values) => translate('zh', key, values) }) {
 let recovery;
 const mismatch = state => new Error(t('error.versionMismatch', { client: version, host: state?.pluginVersion || t('common.unknown') }));
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
   if (result?.application !== 'applied') throw new Error(t('error.reload'));
   const latest = await readState();
   if (latest?.pluginVersion !== version) throw mismatch(latest);
  })();
  await recovery;
 };
}
