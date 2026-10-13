import YahooFantasy from './YahooFantasy';
import EspnFantasy from './EspnFantasy';

export default function LeagueSync() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold text-dark-50">Sync Your League</h1>
        <p className="mt-2 text-dark-400">Connect your fantasy provider and bring your league and roster into ProGM.</p>
      </div>
      <section className="rounded-2xl border border-[#6b4ba1]/40 bg-[#3f2867]/10 p-6">
        <YahooFantasy />
      </section>
      <section className="rounded-2xl border border-red-700/30 bg-red-950/10 p-6">
        <EspnFantasy />
      </section>
    </div>
  );
}
