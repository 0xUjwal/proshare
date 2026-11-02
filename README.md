# ProShare

Private, browser-to-browser file and text sharing. Files travel directly between the two
devices over an encrypted WebRTC channel - they are never uploaded to, or stored on, any server.

## How it works

- **Static site.** The app is plain HTML/JS/CSS. Hosting it only serves the page.
- **WebRTC for data.** Files and text move over WebRTC DataChannels (DTLS, end-to-end encrypted).
  No TURN relay is used, so file bytes never pass through a third party. The tradeoff: some
  restrictive or symmetric-NAT networks cannot establish a direct connection.
- **Nostr relays for discovery only.** To find each other, peers exchange AES-GCM-encrypted
  session descriptions through public [Nostr](https://nostr.com) relays using
  [Trystero](https://github.com/dmotz/trystero) (MIT). The encryption key is derived from a
  256-bit random password carried in the URL `#fragment`, which browsers never send to any
  HTTP server. Relays can observe connection metadata (IP addresses, timing, an opaque room
  tag) but cannot decrypt the signaling. Relay log retention is outside this project's control.
- **Explicit approval.** Every peer that joins is held in a pre-connection handshake and is
  invisible to the session until the host explicitly approves them. Every reconnection is a
  new handshake - approval is never carried over.
- **Plain text only.** Received messages are rendered as text, never as HTML.
- **Integrity.** Every file is SHA-256 hashed by the sender and verified by the receiver
  before it is saved.
- **No tracking.** No analytics, cookies, or third-party scripts.

## Limits (honest ones)

- **The link is the capability.** Anyone holding the full link can request to join while the
  host session is live; the host approves every join individually, and guests cannot exchange
  files or text with each other in the unmodified app. A peer running a deliberately modified
  client shares the same rendezvous secret and could bypass client-side role checks - that is
  inherent to shared-secret rendezvous without accounts. The 6-digit verification code shown
  to both sides is the out-of-band check that you are talking to the person you expect.
- **End session is final.** Closing the host or pressing End session leaves the room; the old
  link is dead and rejoining it fails with a connection error. Only a new session (new link)
  works.

- Received files are held in memory before saving; very large files can strain low-memory
  devices. Per-file limit is 1 GiB.
- Without a TURN relay, connections can fail behind restrictive corporate or mobile networks.
- Either party closing their tab ends the session. Nothing persists.

## Development

```sh
npm install
npm run dev     # local dev server
npm run build   # static build into dist/
```

## Security model in one paragraph

Your share link contains two independent 256-bit secrets (room ID and password) in its URL
fragment. Only someone with the full link can find the room and decrypt its signaling, and
they still cannot receive anything until you approve them. The host and guest can compare a
6-digit verification code shown on both screens to confirm they are talking to each other and
not an impostor. Treat the link like a key: anyone who has it can *request* to join.

## Acknowledgements

Built on [Trystero](https://github.com/dmotz/trystero) (MIT license) for serverless WebRTC
matchmaking. No code from PrivyDrop is used.
