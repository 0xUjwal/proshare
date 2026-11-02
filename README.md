# ProShare

Private, browser-to-browser file and text sharing. The sender opens a room with a
6-digit or custom code; the receiver enters the code, the sender approves, and files
travel directly between the two devices over an encrypted WebRTC channel - they are
never uploaded to, or stored on, any server.

## How it works

- **Static site.** The app is plain HTML/JS/CSS. Hosting it only serves the page.
- **Room codes.** The sender creates a room with an auto-generated 6-digit code or a
  custom code, and shares it (or the one-tap link / QR). The receiver types the code
  to connect. Both devices stay online until the transfer finishes.
- **The code is an address, never a key.** A 6-digit code would be offline-brute-forceable
  as an encryption secret, so it is never used as one. Every pair of peers runs an
  ephemeral ECDH (P-256) exchange inside the connection handshake. The shared secret
  is bound to both peer IDs via HKDF, encrypts the handshake payloads (names,
  accept/reject) with AES-GCM, and yields the 6-digit verification code shown on
  both screens.
- **The code comparison is mandatory.** The sender cannot send files or text until
  they press "Codes match" for that peer, and the receiver cannot reply until they
  confirm. This comparison is the MITM defense: an attacker relaying between the
  two sides holds different ECDH secrets with each, producing different codes.
  WebRTC's own DTLS fingerprints are not exposed by the rendezvous library, so the
  SAS comparison is the binding check - not the DTLS layer.
- **WebRTC for data.** Files and text move over WebRTC DataChannels (DTLS, end-to-end
  encrypted). No TURN relay is used, so file bytes never pass through a third party.
  The tradeoff: some restrictive or symmetric-NAT networks cannot establish a direct
  connection.
- **Nostr relays for discovery only.** Peers find each other through public
  [Nostr](https://nostr.com) relays using [Trystero](https://github.com/dmotz/trystero)
  (MIT). Connection setup passes these relays in readable form: relays - and anyone
  who guesses a live code - can see connection metadata (IP addresses, timing, the
  room tag). File contents are end-to-end encrypted; an active attacker tampering
  with setup is detected by the mandatory code comparison. Relay log retention is
  outside this project's control.
- **Explicit approval.** Every peer that joins is held in a pre-connection handshake
  and is invisible to the session until the sender explicitly approves them. Every
  reconnection is a new handshake - approval is never carried over. Concurrent
  requests are queued, not lost.
- **Plain text only.** Received messages are rendered as text, never as HTML.
- **Integrity.** Every file is SHA-256 hashed by the sender and verified by the
  receiver before it is saved.
- **No tracking.** No analytics, cookies, or third-party scripts.

## Limits (honest ones)

- **A code grants one thing: asking to join.** Anyone who knows or guesses a live
  code can request to join and see that a room exists. The sender approves every
  person individually, and no file or message moves without approval and the
  sender actively sending it.
- **Modified clients.** Peers running a deliberately modified app in the same room
  could bypass client-side role checks - that is inherent to shared rendezvous
  without accounts. The verification code is the out-of-band check that you are
  talking to the person you expect.
- **End session ends your room - it does not retire the code globally.** Closing
  the sender's tab or pressing End session removes the only approving party:
  connecting with that code then fails. A code itself cannot be revoked; treat
  sender-chosen codes as single-session secrets.
- **Code collisions are detected, not prevented.** Two senders opening the same
  code at once cannot be reliably serialized across distributed relays. When it
  happens, the second sender sees "code already in use"; this is best-effort, and
  auto-generated codes make collisions unlikely.
- **Short codes change the attacker model.** A 6-digit code is guessable: expect
  strangers to occasionally request to join busy codes. Approval, the mandatory
  code comparison, and the fact that guessing yields no keys keep the impact at
  "annoyance plus metadata", not content exposure - that is a deliberate usability
  tradeoff, not a proof of safety.
- Received files are held in memory before saving; very large files can strain
  low-memory devices. Per-file limit is 1 GiB.
- Without a TURN relay, connections can fail behind restrictive corporate or
  mobile networks.
- Not independently audited. Do not treat it as a guarantee of complete safety.

## Development

```sh
npm install
npm run dev     # local dev server
npm run build   # static build into dist/
npx tsx --test tests/*.test.mts   # unit tests
```
