import { useEffect, useState } from 'react';
import api from '../services/api';

export default function NewsFeed({ sport }) {
  const [news, setNews] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { setNews(null); setError(''); api.get(`/espn/news/${sport}`).then(response => setNews(response.data)).catch(err => setError(err.response?.data?.error || 'Could not load news')); }, [sport]);
  if (error) return <section className="card text-red-400">{error}</section>;
  if (!news) return <div className="animate-pulse text-primary-400">Loading the latest {sport} news…</div>;
  return <div className="space-y-6"><section className="overflow-hidden rounded-2xl border border-primary-500/30 bg-gradient-to-r from-primary-900/30 to-dark-800 p-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-400">ESPN News</p><h2 className="mt-2 text-3xl font-black">Latest {sport === 'football' ? 'NFL' : 'NBA'} updates</h2><p className="mt-2 text-dark-300">Injuries, transactions, analysis, and stories that can affect your fantasy decisions.</p></section><div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{news.articles.map(article => <a key={article.id} href={article.url} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-xl border border-dark-700 bg-dark-800 transition hover:-translate-y-1 hover:border-primary-500 hover:shadow-xl">{article.image && <img src={article.image} alt="" className="h-44 w-full object-cover" />}<div className="p-5"><div className="flex flex-wrap gap-2">{article.categories.map(category => <span key={category} className="badge-blue">{category}</span>)}</div><h3 className="mt-3 text-lg font-bold leading-6 group-hover:text-primary-300">{article.headline}</h3><p className="mt-2 line-clamp-3 text-sm leading-6 text-dark-400">{article.description}</p><p className="mt-4 text-xs text-dark-500">{article.published ? new Date(article.published).toLocaleString() : 'ESPN'} · Read story →</p></div></a>)}</div></div>;
}
