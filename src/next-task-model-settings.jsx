import { useEffect, useState } from 'react';

export function NextTaskModelSettings({ settings, busy, act, readCatalog, t }) {
 const provider = settings?.provider ?? '', model = settings?.model ?? '';
 const [draft, setDraft] = useState(() => ({ provider, model, custom: Boolean(provider || model) }));
 const [catalog, setCatalog] = useState({ providers: [], models: [], loading: false });
 const [error, setError] = useState('');
 useEffect(() => { setDraft({ provider, model, custom: Boolean(provider || model) }); setError(''); }, [provider, model]);
 useEffect(() => {
  if (!draft.custom) return;
  let alive = true;
  setCatalog(previous => ({ ...previous, models: [], loading: true, reason: undefined }));
  const timer = setTimeout(() => {
   void readCatalog(draft.provider.trim()).then(value => { if (alive) setCatalog({ providers: value.providers ?? [], models: value.models ?? [], reason: value.reason, loading: false }); })
    .catch(() => { if (alive) setCatalog({ providers: [], models: [], loading: false, reason: 'model-catalog' }); });
  }, 250);
  return () => { alive = false; clearTimeout(timer); };
 }, [draft.custom, draft.provider, readCatalog]);
 const selected = { provider: draft.custom ? draft.provider.trim() : '', model: draft.custom ? draft.model.trim() : '' };
 const valid = !draft.custom || Boolean(selected.provider && selected.model);
 const dirty = selected.provider !== provider || selected.model !== model;
 const update = patch => { setDraft(previous => ({ ...previous, ...patch })); setError(''); };
 const save = async event => {
  event.preventDefault();
  if (busy) return;
  if (!valid) { setError(t('nextTasks.routeRequired')); return; }
  setError('');
  try { await act({ type: 'settings.update', patch: { nextTasks: selected } }, t('nextTasks.routeSaved')); }
  catch (reason) { setError(reason.message); }
 };
 return <form className="sk-model-form" onSubmit={event => void save(event)} data-toolbox-model-settings>
  <div className="row sk-model-mode">
   <label className="sk-field"><span>{t('nextTasks.route')}</span><select value={draft.custom ? 'custom' : 'session'} disabled={busy || !settings} onChange={event => update({ custom: event.target.value === 'custom' })}>
    <option value="session">{t('nextTasks.follow')}</option><option value="custom">{t('nextTasks.custom')}</option>
   </select></label>
   <button className="primary" type="submit" disabled={busy || !settings || !dirty || !valid}>{t(busy ? 'common.busy' : 'common.save')}</button>
  </div>
  {draft.custom && <>
   <div className="sk-fields">
    <label className="sk-field"><span>{t('nextTasks.provider')}</span><input value={draft.provider} disabled={busy} list="toolbox-next-providers" maxLength={256} autoComplete="off" spellCheck={false} aria-describedby="toolbox-next-model-help" aria-invalid={Boolean(error) && !selected.provider} onBlur={() => { if (!valid) setError(t('nextTasks.routeRequired')); }} onChange={event => update({ provider: event.target.value, model: '' })} /></label>
    <label className="sk-field"><span>{t('nextTasks.model')}</span><input value={draft.model} disabled={busy} list="toolbox-next-models" maxLength={256} autoComplete="off" spellCheck={false} aria-describedby="toolbox-next-model-help" aria-invalid={Boolean(error) && !selected.model} onBlur={() => { if (!valid) setError(t('nextTasks.routeRequired')); }} onChange={event => update({ model: event.target.value })} /></label>
   </div>
   <datalist id="toolbox-next-providers">{catalog.providers.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</datalist>
   <datalist id="toolbox-next-models">{catalog.models.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</datalist>
   <p id="toolbox-next-model-help" className="muted sk-caption">{t('nextTasks.routeHelp')}</p>
   {catalog.loading && <p className="muted sk-caption" role="status">{t('nextTasks.catalogLoading')}</p>}
   {catalog.reason && <p className="muted sk-caption" role="status">{t('nextTasks.catalogUnavailable')}</p>}
  </>}
  {error && <p className="error" role="alert">{error}</p>}
  <p className="muted sk-caption">{t('nextTasks.noFallback')}</p>
 </form>;
}
