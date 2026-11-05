import { Duplex } from 'node:stream';

// Carries an ordinary TLS byte stream. Relay metadata never authenticates a
// peer: the inner TLS connection and locally pinned certificates do that.
export function byteChannel({ send, close, pause = () => {}, resume = () => {} }) {
  const channel = new Duplex({
    highWaterMark: 65536,
    read() { resume(); },
    write(chunk, _encoding, done) {
      (async () => { for (let i = 0; i < chunk.length; i += 32768) await send(chunk.subarray(i, i + 32768)); })().then(() => done(), done);
    },
    destroy(error, done) { close(); done(error); },
    final(done) { close(); done(); },
  });
  channel.on('error', () => {});
  channel.receive = data => { if (data.length > 65536) { channel.destroy(new Error('Tunnel frame too large')); return; } if (!channel.push(data)) pause(); };
  return channel;
}
