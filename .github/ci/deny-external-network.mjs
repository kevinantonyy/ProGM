// CI guard, preloaded with NODE_OPTIONS=--import. Tests must use mocks: any fetch or socket to a non-loopback host throws.
import net from 'node:net';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const isLocal = (host) => host == null || host === '' || LOCAL.has(String(host).toLowerCase());
const blocked = (host) => new Error(`CI network guard: blocked connection to ${host}. Tests must not call external services.`);

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!isLocal(url.hostname)) throw blocked(url.hostname);
  return realFetch(input, init);
};

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const [first, second] = args;
  const options = Array.isArray(first) ? first[0] : first; // net.connect() hands over normalized [options, callback]
  const host = typeof options === 'object' && options !== null ? options.host : typeof second === 'string' ? second : undefined;
  if (!isLocal(host)) throw blocked(host);
  return realConnect.apply(this, args);
};
