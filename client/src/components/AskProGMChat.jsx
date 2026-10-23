import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import AiConsentDialog from './AiConsentDialog';
import PersonalizationBar from './PersonalizationBar';
import {
  basketballChatPayload, personalizedChatPayload, answerTag, QUICK_QUESTIONS,
  YAHOO_AI_INTRO, YAHOO_AI_SUBTITLE, YAHOO_AI_PERSONAL_INTRO, YAHOO_AI_PERSONAL_SUBTITLE,
} from '../utils/aiSharing';

// Ask ProGM (basketball). General chat always works. Personalization is OFF until the user reads the server-supplied disclosure and agrees;
// the server records the choice, re-checks it on every question, and builds the league summary itself. This component never sends league data.
export default function AskProGMChat({ leagueKey, teamKey }) {
  const [consent, setConsent] = useState({ status: 'loading', version: null, disclosure: null });
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [messages, setMessages] = useState([{ role: 'gm', text: YAHOO_AI_INTRO }]);
  const [historyToken, setHistoryToken] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);

  const loadConsent = useCallback(async () => {
    try {
      const { data } = await api.get('/gm/consent');
      if (!data.available) setConsent({ status: 'unavailable', version: null, disclosure: null });
      else setConsent({ status: data.granted ? 'on' : 'off', version: data.version, disclosure: data.disclosure });
    } catch { setConsent({ status: 'unavailable', version: null, disclosure: null }); }
  }, []);
  useEffect(() => { loadConsent(); }, [loadConsent]);

  const personalized = consent.status === 'on';
  async function agree() {
    setBusy(true); setDialogError('');
    try {
      await api.post('/gm/consent', { version: consent.version });
      setConsent((c) => ({ ...c, status: 'on' })); setDialog(false); setHistoryToken(null);
      setMessages((m) => [...m, { role: 'gm', text: YAHOO_AI_PERSONAL_INTRO }]);
    } catch (err) {
      if (err.response?.status === 409) { await loadConsent(); setDialogError('The sharing text was updated. Please read it again before agreeing.'); }
      else setDialogError(err.response?.data?.error || 'Could not save your choice. Nothing was shared.');
    } finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true); setPreview(null);
    try { await api.delete('/gm/consent'); setConsent((c) => ({ ...c, status: 'off' })); setHistoryToken(null); setMessages((m) => [...m, { role: 'gm', text: 'Personalization is off. Earlier personalized replies remain visible here but will not be sent with your next question.' }]); }
    catch (err) { setError(err.response?.data?.error || 'Could not turn sharing off. Please try again.'); }
    finally { setBusy(false); }
  }
  async function send(value = text) {
    const clean = value.trim().slice(0, 800); if (!clean || sending || busy || dialog) return;
    const next = [...messages, { role: 'user', text: clean }]; setMessages(next); setText(''); setError(''); setPreview(null); setSending(true);
    try {
      const body = personalized ? personalizedChatPayload(next, { leagueKey, teamKey }) : basketballChatPayload(next, historyToken);
      const r = await api.post('/gm/chat', body);
      setHistoryToken(r.data.historyToken || null);
      setMessages((m) => [...m, { role: 'gm', text: r.data.message, meta: { shared: r.data.leagueDataShared, sections: r.data.leagueSections, notice: personalized ? r.data.leagueDataNotice : null, sent: r.data.leagueContextSent } }]);
    } catch (err) { setError(err.response?.data?.error || 'Ask ProGM could not respond.'); }
    finally { setSending(false); }
  }
  async function showPreview() {
    if (!text.trim()) return;
    try { const r = await api.post('/gm/context-preview', { question: text.trim().slice(0, 800), contextRequest: 'yahoo_league', leagueKey, teamKey }); setPreview(r.data); }
    catch (err) { setPreview({ leagueDataShared: false, leagueDataNotice: err.response?.data?.error || 'Could not prepare a preview.' }); }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="card p-0">
        <div className="border-b border-dark-700 px-4 py-3"><p className="font-bold">ProGM Assistant</p><p className="text-xs text-green-400">● {personalized ? YAHOO_AI_PERSONAL_SUBTITLE : YAHOO_AI_SUBTITLE}</p></div>
        <PersonalizationBar status={consent.status} busy={busy} onEnable={() => { setDialogError(''); setDialog(true); }} onDisable={disable} />
        <div className="h-[52vh] min-h-[340px] space-y-4 overflow-y-auto p-4">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${m.role === 'user' ? 'rounded-br-sm bg-primary-600 text-white' : 'rounded-bl-sm border border-dark-700 bg-dark-900 text-dark-200'}`}>
                {m.text}
                {m.role === 'gm' && m.meta && (
                  <div className="mt-2 border-t border-dark-700 pt-2 text-xs text-dark-400">
                    <p>{answerTag(m.meta)}</p>
                    {m.meta.notice && <p className="mt-1 text-dark-200">{m.meta.notice}</p>}
                    {m.meta.shared && m.meta.sent && (
                      <details className="mt-1"><summary className="min-h-[44px] cursor-pointer py-2 text-primary-400">See what was sent</summary>
                        <p className="mb-1">Exactly this text was sent to Google Gemini with your question:</p>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-dark-950 p-2 text-[11px] text-dark-300">{m.meta.sent}</pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {sending && <div className="text-sm text-primary-400">Thinking…</div>}
          {error && <div role="alert" className="rounded-lg border border-red-700/50 bg-red-900/20 p-3 text-sm text-red-300">{error}</div>}
        </div>
        <div className="border-t border-dark-700 p-4">
          {personalized && <div className="mb-3 flex gap-2 overflow-x-auto">{QUICK_QUESTIONS.map((q) => <button key={q} type="button" disabled={sending} onClick={() => send(q)} className="min-h-[44px] whitespace-nowrap rounded-full border border-dark-600 bg-dark-900 px-3 py-1.5 text-xs text-dark-300 hover:border-primary-500 hover:text-white">{q}</button>)}</div>}
          <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex gap-2">
            <input className="input-field" value={text} maxLength={800} onChange={(e) => setText(e.target.value)} aria-label="Message Ask ProGM" placeholder={personalized ? 'Ask about your lineup, waivers, or a trade…' : 'Ask a general fantasy basketball question…'} />
            <button className="btn-primary min-h-[44px] shrink-0 disabled:opacity-50" disabled={!text.trim() || sending || busy || dialog}>Send</button>
          </form>
          {personalized && <button type="button" onClick={showPreview} disabled={!text.trim()} className="mt-2 min-h-[44px] text-sm text-primary-400 disabled:opacity-40">Preview what would be sent</button>}
          {preview && (
            <div className="mt-2 rounded-lg border border-dark-700 bg-dark-900 p-3 text-xs text-dark-300" aria-live="polite">
              {preview.leagueDataShared
                ? <><p>This question would send these parts of your league to Google Gemini: {(preview.leagueSections || []).join(', ')}.</p><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-dark-950 p-2 text-[11px]">{preview.leagueContextSent}</pre></>
                : <p>No league data would be sent. {preview.leagueDataNotice}</p>}
            </div>
          )}
          <p className="mt-2 text-xs text-dark-500">{personalized ? 'Answers use your league summary and are not guaranteed outcomes.' : 'General AI advice from what you type. Not based on your league.'}</p>
        </div>
      </section>
      {dialog && consent.disclosure && <AiConsentDialog disclosure={consent.disclosure} busy={busy} error={dialogError} onAgree={agree} onCancel={() => setDialog(false)} />}
    </div>
  );
}
